// 二重配送（同じメッセージが channel 経由＋PTY 注入の 2 回届く）の回帰ガード。
//
// 【2026-08-09 実障害・第 1 波】
// engineer エビの reply_to_master が master セッションへ 2 回届いた（1 回目は
// `<channel …>` タグ付き、2 回目は数分〜十数分後に同一本文の生テキスト）。
// 配送ログ（.ebi-team/delivery.log）の時系列:
//   23:27:44 reply 発行 → 23:27:52.98（＝ちょうど +8.05s）echo-timeout →
//   同 23:27:52.98 「master が busy のため注入を保留（idle 復帰時に flush）」
// つまり notification は ACK されて実際に届いていたのに、宛先（master）が busy で
// harness がターン境界まで本文を描画しなかったため ECHO_CONFIRM_MS(8s) 内にエコーを
// 観測できず、PTY 注入へフォールバック → busy なのでキューに滞留 → idle 復帰で流れて
// 2 通目になっていた。
// 修正: フォールバック注入に echo guard を持たせ、**stdin へ書く直前**に再照合する。
//
// 【2026-08-16 実障害・第 2 波（本命）】
// 上の修正を入れても二重着弾が止まらなかった。判定**タイミング**は直ったが判定**手段**が
// 壊れていた: 針は「本文の先頭 24 **文字**」だったのに、claude TUI の channel 1 行描画は
// 「表示**カラム**」（実測 80 桁端末で約 56 桁）で切り詰める。日本語は 1 文字 = 2 カラムなので
// 実際に描画される本文は 21〜23 文字しかなく、**和文では針が原理的に届かない**＝照合が
// 100% 失敗していた（実測: echo-timeout 94 件に対し duplicate-suppressed 0 件。半角の多い
// メッセージだけは 32 文字描画されて針が届き、二重にならずに済んでいた）。
// 修正: 針を「msgId 入りの行頭タグ」（`[from:master#90] `）へ変更。タグは必ず行頭にあり
// 切り詰めの影響を受けず、msgId で一意なので本文の言語・長さ・表示幅に依存しない。
// 両経路（notification = control-server.ts / PTY = agent.inject）が deliveryTag() を
// 共用することが不変条件で、本ファイルの「タグ表記が完全一致する」テストで錠前を掛ける。
//
// 実行: node --import tsx --test test/dupDelivery.test.ts

import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

// registry.ts / agent.ts はモジュール読込時に env を読むので、動的 import より前に設定する。
process.env.EBI_DELIVER_ACK_TIMEOUT_MS = "300";
process.env.EBI_ECHO_CONFIRM_MS = "600";
process.env.EBI_ECHO_FLUSH_GRACE_MS = "400";
delete process.env.EBI_INJECT_MODE;

const { Registry } = await import("../src/server/registry.ts");
const { Mailbox } = await import("../src/server/mailbox.ts");
import type { SpawnConfig, AgentHandlers } from "../src/server/agent.ts";
import { deliveryTag, deliveryText } from "../src/shared/deliveryTag.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const spawnConfig: SpawnConfig = {
  command: "bash",
  args: ["-c", "cat"],
  idleThresholdMs: 150,
  scrollbackBytes: 256 * 1024,
  devChannelsAllowlist: [],
};
const handlers: AgentHandlers = {
  onData() {},
  onStatus() {},
  onExit() {},
  onNotice() {},
};

// hasControlBridge を満たす fake claude。PTY へ書いた内容は端末エコーで **1 回だけ**
// scrollback に現れる（`cat` にすると端末エコー＋cat 出力で 2 回になり、重複の数え上げが
// 曖昧になるため、アプリ側の出力は捨てる）。
const fakeClaudeDir = mkdtempSync(join(tmpdir(), "ebi-fake-claude-dup-"));
const fakeClaude = join(fakeClaudeDir, "claude");
writeFileSync(fakeClaude, "#!/bin/sh\nexec cat > /dev/null\n", { mode: 0o755 });
const bridgeLaunch = (cwd: string) => ({
  command: fakeClaude,
  args: ["--mcp-config", "/dev/null"],
  cwd,
  model: null,
});

const registries: InstanceType<typeof Registry>[] = [];
function makeRegistry(mb: InstanceType<typeof Mailbox>) {
  const dump = join(tmpdir(), `ebi-dup-test-${registries.length}.json`);
  const r = new Registry(spawnConfig, dump, mb);
  registries.push(r);
  return r;
}
afterEach(() => {
  for (const r of registries.splice(0)) r.killAll();
});
after(() => rmSync(fakeClaudeDir, { recursive: true, force: true }));

/** compact 済み scrollback に needle が何回現れるか。 */
function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}
const compact = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\s+/g, "");

/** 対象を busy に保ち続けるドライバ（stop() で解除）。 */
function keepBusy(agent: { write(d: string): void }) {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      agent.write(".");
      await sleep(60);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
    },
  };
}

const BODY = "報告ID R-001 二重配送の調査が完了しました";

/**
 * 実機の TUI 描画を模した channel 受信行を作る。
 * 第 2 波の障害を正しく再現するため、**表示カラムで切り詰める**（80 桁端末での実測に合わせ、
 * 全角 2 桁・半角 1 桁で数えて 56 桁で打ち切る）。和文本文では本文が 21〜23 文字しか残らない。
 */
function renderChannelLine(from: string, body: string, msgId: number, columns = 56): string {
  const full = deliveryText(from, body, msgId);
  let cols = 0;
  let out = "";
  for (const ch of full) {
    const w = /[　-〿぀-ヿ㐀-䶿一-鿿＀-｠￠-￦]/.test(ch)
      ? 2
      : 1;
    if (cols + w > columns) break;
    cols += w;
    out += ch;
  }
  return `ebi-control: ${out}…`;
}

// ===== 不変条件: 2 経路のタグ表記が完全一致する =====

test("錠前: notification 経路と PTY 注入経路の行頭タグ表記が完全一致する", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  const agent = reg.spawn(".", handlers, { id: "ebi-tag", launch: bridgeLaunch(".") });

  // notification 経路が組み立てる本文（src/mcp/control-server.ts と同じ deliveryText）。
  const viaNotify = deliveryText("master", BODY, 90);
  // PTY 注入経路が stdin へ書く本文（Agent.inject の内部と同じ組み立て）。
  agent.inject("master", BODY, undefined, 90);
  await sleep(300);

  assert.ok(
    compact(agent.getScrollback()).includes(compact(viaNotify)),
    "PTY 注入の本文は notification の content と 1 文字も違わないこと" +
      "（ズレると msgId タグ照合が外れ、二重配送の抑止が静かに壊れる）",
  );
  assert.equal(deliveryTag("master", 90), "[from:master#90] ");
  assert.equal(deliveryTag("master"), "[from:master] ", "msgId 無し（PTY 専用経路）は従来書式");
});

// ===== 第 2 波の本命回帰: 和文長文 =====

test("回帰(和文長文): 表示幅で切り詰められてもタグで照合が成立し、PTY 注入が抑止される", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  const master = reg.spawn(".", handlers, {
    id: "master",
    kind: "master",
    launch: bridgeLaunch("."),
  });

  // 実障害と同じ形の和文長文（旧実装ではこれが 100% 二重着弾していた）。
  const jaBody =
    "【ボス目視フィードバック・修正2点】スキル倉庫の左ペイン一覧: " +
    "1. 未入手の帯（「？？？ 未入手◯本」）は削除 2. カードデザインをやめて一覧表示に変更してほしい";

  let msgId = 0;
  const bridge = (async () => {
    const msgs = await mb.subscribe("master", 3000);
    mb.ack("master", msgs.map((m) => m.id));
    msgId = msgs[0]!.id;
  })();

  const busy = keepBusy(master);
  await sleep(200); // busy を確立させる
  const out = await reg.deliver("master", "vc-lp", jaBody, "reply");
  await bridge;

  assert.equal(out.via, "pty-fallback", "busy なので描画が間に合わず PTY へ載せ替わる");
  assert.equal(out.queued, true, "master が busy なので注入は滞留する（実障害と同じ状態）");

  // harness が遅れて channel 行を描画した。実機同様、本文は表示幅で切り詰められている。
  const rendered = renderChannelLine("vc-lp", `[reply] ${jaBody}`, msgId);
  assert.ok(
    !compact(rendered).includes(compact(jaBody).slice(0, 24)),
    "前提確認: 本文先頭 24 文字は描画に現れない（旧方式の針では原理的に一致しなかった）",
  );
  master.write(`${rendered}\n`);
  await sleep(200);

  // idle 復帰 → flush（guard がタグを再照合して注入を取りやめるはず）。
  await busy.stop();
  await sleep(1500);

  const seen = compact(master.getScrollback());
  assert.equal(
    countOccurrences(seen, compact(deliveryTag("vc-lp", msgId))),
    1,
    "タグの出現は channel 描画の 1 回だけ。PTY 注入による 2 通目は抑止される",
  );
  assert.equal(
    countOccurrences(seen, compact(jaBody)),
    0,
    "切り詰められた描画しか無い＝本文全体は 1 度も注入されていない",
  );
});

// ===== 第 1 波の回帰（英数字本文・従来ケース）=====

test("回帰: busy で echo-timeout → 滞留した注入は、channel 行が描画されたら flush 時に抑止される", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  const master = reg.spawn(".", handlers, {
    id: "master",
    kind: "master",
    launch: bridgeLaunch("."),
  });

  // ブリッジ役: ack は返す（＝notification は確かに転送された）が、
  // busy な harness はまだ本文を描画しない。
  let msgId = 0;
  const bridge = (async () => {
    const msgs = await mb.subscribe("master", 3000);
    mb.ack("master", msgs.map((m) => m.id));
    msgId = msgs[0]!.id;
  })();

  const busy = keepBusy(master);
  await sleep(200); // busy を確立させる
  const out = await reg.deliver("master", "vc-lp", BODY, "reply");
  await bridge;

  assert.equal(out.via, "pty-fallback", "8s（テストでは 600ms）でエコーが出ず PTY へ載せ替わる");
  assert.equal(out.queued, true, "master が busy なので注入は滞留する（実障害と同じ状態）");

  // harness が遅れて channel 本文を描画した（＝1 通目は実際に届いていた）。
  master.write(`ebi-control: ${deliveryText("vc-lp", `[reply] ${BODY}`, msgId)}\n`);
  await sleep(200);

  // idle 復帰 → flush（guard がエコーを再照合して注入を取りやめるはず）。
  await busy.stop();
  await sleep(1500);

  const seen = compact(master.getScrollback());
  assert.equal(
    countOccurrences(seen, compact(BODY)),
    1,
    "本文は channel 描画の 1 回だけ。PTY 注入による 2 通目は抑止される",
  );
});

test("channel 行が描画されない場合は従来どおり flush で注入する（取りこぼさない）", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  const master = reg.spawn(".", handlers, {
    id: "master",
    kind: "master",
    launch: bridgeLaunch("."),
  });

  let msgId = 0;
  const bridge = (async () => {
    const msgs = await mb.subscribe("master", 3000);
    mb.ack("master", msgs.map((m) => m.id));
    msgId = msgs[0]!.id;
  })();

  const busy = keepBusy(master);
  await sleep(200);
  const out = await reg.deliver("master", "vc-lp", BODY, "reply");
  await bridge;
  assert.equal(out.queued, true);

  // 描画は起きない（harness が channel を捨てたケース）。
  await busy.stop();
  await sleep(1500);

  const seen = compact(master.getScrollback());
  assert.equal(
    countOccurrences(seen, compact(BODY)),
    1,
    "PTY 注入で確実に 1 回届く（抑止しすぎて消えない）",
  );
  assert.ok(
    seen.includes(compact(deliveryText("vc-lp", `[reply] ${BODY}`, msgId))),
    "注入本文が msgId タグ付きで入力欄へ入っている",
  );
});

test("idle な相手への guard 付き注入も、書く直前に描画済みなら suppressed（重複を作らない）", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  const agent = reg.spawn(".", handlers, { id: "ebi-9", launch: bridgeLaunch(".") });

  const mark = agent.scrollbackMark();
  // エコー確認の締切「直後」に描画されたケース（deliver は既にフォールバックを決めている）。
  agent.write(`ebi-control: ${deliveryText("vc-lp", `[reply] ${BODY}`, 12)}\n`);
  await sleep(400); // idle 化 ＋ 描画の反映を待つ

  let suppressed = 0;
  const state = agent.inject(
    "vc-lp",
    `[reply] ${BODY}`,
    { tag: deliveryTag("vc-lp", 12), mark, onSuppress: () => { suppressed += 1; } },
    12,
  );
  await sleep(300);

  assert.equal(state, "suppressed", "描画済みなら書かずに取りやめる");
  assert.equal(suppressed, 1, "抑止は配送ログへ通知される");
  assert.equal(
    countOccurrences(compact(agent.getScrollback()), compact(BODY)),
    1,
    "本文は描画の 1 回だけ",
  );
});

test("回帰: 別の msgId の描画では抑止しない（取りこぼしを作らない）", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  const agent = reg.spawn(".", handlers, { id: "ebi-11", launch: bridgeLaunch(".") });

  const mark = agent.scrollbackMark();
  // 直前に届いた **別の** メッセージ（msgId=12）の描画。これを根拠に msgId=13 を抑止しては
  // ならない（本文が似ていても別配送＝取りこぼしになる）。
  agent.write(`ebi-control: ${deliveryText("vc-lp", `[reply] ${BODY}`, 12)}\n`);
  await sleep(400);

  const state = agent.inject(
    "vc-lp",
    `[reply] ${BODY}`,
    { tag: deliveryTag("vc-lp", 13), mark },
    13,
  );
  await sleep(300);

  assert.equal(state, "sent", "別 msgId の描画は抑止の根拠にしない");
  assert.ok(
    compact(agent.getScrollback()).includes(compact(deliveryTag("vc-lp", 13))),
    "msgId=13 の本文は確かに注入される",
  );
});

test("guard が無い通常の注入（PTY 専用経路）は従来どおり必ず送る", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  const agent = reg.spawn(".", handlers, { id: "ebi-10", launch: bridgeLaunch(".") });
  agent.write(`ebi-control: [from:master] ${BODY}\n`);
  await sleep(400);

  const state = agent.inject("master", BODY);
  await sleep(300);
  assert.equal(state, "sent");
  assert.equal(
    countOccurrences(compact(agent.getScrollback()), compact(BODY)),
    2,
    "guard なしは抑止しない（既存挙動を変えない）",
  );
  assert.equal(
    countOccurrences(compact(agent.getScrollback()), compact(deliveryTag("master"))),
    2,
    "msgId 無しの経路は従来どおり `[from:master] ` 書式のまま",
  );
});
