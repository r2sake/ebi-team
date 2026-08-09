// 二重配送（同じ本文が channel タグ付き＋PTY 生テキストの 2 回届く）の回帰ガード。
//
// 【2026-08-09 実障害】
// engineer エビの reply_to_master が master セッションへ 2 回届いた（1 回目は
// `<channel …>` タグ付き、2 回目は数分〜十数分後に同一本文の生テキスト）。
// 配送ログ（.ebi-team/delivery.log）の時系列:
//   23:27:44 reply 発行 → 23:27:52.98（＝ちょうど +8.05s）echo-timeout →
//   同 23:27:52.98 「master が busy のため注入を保留（idle 復帰時に flush）」
// つまり notification は ACK されて実際に届いていたのに、宛先（master）が busy で
// harness がターン境界まで本文を描画しなかったため ECHO_CONFIRM_MS(8s) 内にエコーを
// 観測できず、PTY 注入へフォールバック → busy なのでキューに滞留 → idle 復帰で流れて
// 2 通目になっていた。
//
// 修正: フォールバック注入に echo guard を持たせ、**stdin へ書く直前**に再照合する。
// 既に channel 経由で描画されていれば注入を取りやめる（重複抑止）。
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

test("回帰: busy で echo-timeout → 滞留した注入は、channel 本文が描画されたら flush 時に抑止される", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  const master = reg.spawn(".", handlers, {
    id: "master",
    kind: "master",
    launch: bridgeLaunch("."),
  });

  // ブリッジ役: ack は返す（＝notification は確かに転送された）が、
  // busy な harness はまだ本文を描画しない。
  const bridge = (async () => {
    const msgs = await mb.subscribe("master", 3000);
    mb.ack("master", msgs.map((m) => m.id));
  })();

  const busy = keepBusy(master);
  await sleep(200); // busy を確立させる
  const out = await reg.deliver("master", "vc-lp", BODY, "reply");
  await bridge;

  assert.equal(out.via, "pty-fallback", "8s（テストでは 600ms）でエコーが出ず PTY へ載せ替わる");
  assert.equal(out.queued, true, "master が busy なので注入は滞留する（実障害と同じ状態）");

  // harness が遅れて channel 本文を描画した（＝1 通目は実際に届いていた）。
  master.write(`ebi-control: [from:vc-lp] [reply] ${BODY}\n`);
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

test("channel 本文が最後まで描画されない場合は従来どおり flush で注入する（取りこぼさない）", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  const master = reg.spawn(".", handlers, {
    id: "master",
    kind: "master",
    launch: bridgeLaunch("."),
  });

  const bridge = (async () => {
    const msgs = await mb.subscribe("master", 3000);
    mb.ack("master", msgs.map((m) => m.id));
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
  assert.ok(seen.includes(compact(`[from:vc-lp] [reply] ${BODY}`)), "注入本文が入力欄へ入っている");
});

test("idle な相手への guard 付き注入も、書く直前に描画済みなら suppressed（重複を作らない）", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  const agent = reg.spawn(".", handlers, { id: "ebi-9", launch: bridgeLaunch(".") });

  const mark = agent.scrollbackMark();
  // エコー確認の締切「直後」に描画されたケース（deliver は既にフォールバックを決めている）。
  agent.write(`ebi-control: [from:vc-lp] [reply] ${BODY}\n`);
  await sleep(400); // idle 化 ＋ 描画の反映を待つ

  let suppressed = 0;
  const state = agent.inject("vc-lp", `[reply] ${BODY}`, {
    payload: BODY,
    tag: "[from:vc-lp] [reply] ",
    mark,
    onSuppress: () => {
      suppressed += 1;
    },
  });
  await sleep(300);

  assert.equal(state, "suppressed", "描画済みなら書かずに取りやめる");
  assert.equal(suppressed, 1, "抑止は配送ログへ通知される");
  assert.equal(
    countOccurrences(compact(agent.getScrollback()), compact(BODY)),
    1,
    "本文は描画の 1 回だけ",
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
});
