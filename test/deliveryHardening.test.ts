// 配送機構ハードニング（2026-08-04）の回帰ガード。
//
// 背景: 幽霊 master 二重購読インシデント（tmp/delivery-investigation-2026-08-04.md）。
// 同じ EBI_ID を名乗る無関係なプロセスが購読を横取りし、master 宛の約半分が
// 「配信確認済み」と報告されながら永久に届かなかった。本テストはその恒久対策 5 点を固定する:
//   1. 二重購読の検出・拒否（Mailbox.claimSubscriber / releaseSubscriber）
//   2. channelProven の鮮度化（shouldSkipEchoConfirm）
//   3. エコー needle のタグ長オフセット（echoNeedle / containsEcho）
//   4. confirmed と queued の区別（deliver / Agent.inject）
//   5. 配送 warn の恒久ログ化（deliveryLog）
//
// 実行: node --import tsx --test test/deliveryHardening.test.ts

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

// deliver の待ちを短くしてテストを速くする（registry.ts はモジュール読込時に env を読む）。
process.env.EBI_DELIVER_ACK_TIMEOUT_MS = "300";
process.env.EBI_ECHO_CONFIRM_MS = "600";
delete process.env.EBI_INJECT_MODE;

const { Registry, shouldSkipEchoConfirm } = await import("../src/server/registry.ts");
const { Mailbox } = await import("../src/server/mailbox.ts");
const { echoNeedle, containsEcho } = await import("../src/server/agent.ts");
const { configureDeliveryLog, logDelivery, flushDeliveryLog } = await import("../src/server/deliveryLog.ts");
import type { SpawnConfig, AgentHandlers } from "../src/server/agent.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ===== 1. 二重購読の検出・拒否 =====

test("二重購読: 先着が所有し、別トークンの後着は拒否される（幽霊の横取りを止める）", () => {
  const mb = new Mailbox();
  assert.deepEqual(mb.claimSubscriber("master", "pid-100"), { ok: true, mode: "claimed" });
  // 同一トークンの再接続（long-poll の張り直し）は当然通る。
  assert.deepEqual(mb.claimSubscriber("master", "pid-100"), { ok: true, mode: "held" });

  const ghost = mb.claimSubscriber("master", "pid-999");
  assert.equal(ghost.ok, false, "別プロセスの後着は拒否する（旧実装は無言で席を奪っていた）");
  if (ghost.ok) return;
  assert.equal(ghost.holder.token, "pid-100");
  assert.equal(ghost.holder.rejected, 1);
  assert.match(ghost.reason, /二重購読/);
  // 拒否されても所有者は変わらない。
  assert.equal(mb.subscriberToken("master"), "pid-100");
});

test("二重購読: 所有者が無音のまま失効時間を過ぎたら後着が引き継げる（正当な再起動の救済）", () => {
  const mb = new Mailbox(40_000, 1_000);
  const t0 = 10_000_000;
  mb.claimSubscriber("ebi-1", "old", t0);
  // 失効前は拒否。
  assert.equal(mb.claimSubscriber("ebi-1", "new", t0 + 900).ok, false);
  // 失効後は引き継ぎ。
  const taken = mb.claimSubscriber("ebi-1", "new", t0 + 1_100);
  assert.equal(taken.ok, true);
  if (!taken.ok) return;
  assert.equal(taken.mode, "takeover");
  assert.equal(taken.previousToken, "old");
  assert.equal(mb.subscriberToken("ebi-1"), "new");
});

test("二重購読: long-poll のコネクション断で所有権を即解放する（再起動が締め出されない）", async () => {
  const mb = new Mailbox();
  mb.claimSubscriber("ebi-1", "old");
  const ctrl = new AbortController();
  const poll = mb.subscribe("ebi-1", 5000, { token: "old", signal: ctrl.signal });

  // ブリッジのプロセスが死んで HTTP コネクションが切れた状況。
  ctrl.abort();
  assert.deepEqual(await poll, [], "待ちは空配列で解ける（fetch を詰まらせない）");
  assert.equal(mb.subscriberToken("ebi-1"), null, "席は返却済み");
  // 再起動した正規ブリッジ（新トークン）は失効を待たず座れる。
  assert.deepEqual(mb.claimSubscriber("ebi-1", "restarted"), { ok: true, mode: "claimed" });
});

test("二重購読: 他人のトークンでは所有権を解放できない / clear で解放される", () => {
  const mb = new Mailbox();
  mb.claimSubscriber("ebi-1", "owner");
  assert.equal(mb.releaseSubscriber("ebi-1", "ghost"), false);
  assert.equal(mb.subscriberToken("ebi-1"), "owner");
  assert.equal(mb.releaseSubscriber("ebi-1", "owner"), true);

  mb.claimSubscriber("ebi-1", "owner2");
  mb.clear("ebi-1"); // agent 破棄。
  assert.equal(mb.subscriberToken("ebi-1"), null);
});

test("二重購読: token 未提示（旧ブリッジ）は所有権管理の対象外＝従来どおり通す", () => {
  const mb = new Mailbox();
  assert.deepEqual(mb.claimSubscriber("ebi-1", undefined), { ok: true, mode: "untracked" });
  assert.deepEqual(mb.claimSubscriber("ebi-1", null), { ok: true, mode: "untracked" });
  assert.equal(mb.subscriberToken("ebi-1"), null);
});

// ===== 2. channelProven の鮮度化 =====

test("channelProven: 未確認なら必ず確認する / master は毎回確認する", () => {
  const opts = { reconfirmMs: 600_000, alwaysMaster: true };
  assert.equal(shouldSkipEchoConfirm("dynamic", null, opts), false, "未確認はスキップしない");
  assert.equal(shouldSkipEchoConfirm("master", 10, opts), false, "master は実績があっても毎回確認する");
  assert.equal(shouldSkipEchoConfirm("dynamic", 10, opts), true, "確認直後はスキップ（無駄な待ちを作らない）");
  assert.equal(
    shouldSkipEchoConfirm("dynamic", 600_001, opts),
    false,
    "鮮度切れは再確認する（一度の成功で永久に信用しない＝インシデントの穴）",
  );
});

test("channelProven: EBI_ECHO_RECONFIRM_MS<=0 は旧挙動（永久に信用）へロールバックできる", () => {
  const opts = { reconfirmMs: 0, alwaysMaster: true };
  assert.equal(shouldSkipEchoConfirm("master", 1, opts), true);
  assert.equal(shouldSkipEchoConfirm("dynamic", 10 ** 9, opts), true);
  assert.equal(shouldSkipEchoConfirm("master", null, opts), false, "未確認だけは常に確認する");
});

test("channelProven: alwaysMaster を切ると master も鮮度ベースになる", () => {
  const opts = { reconfirmMs: 1000, alwaysMaster: false };
  assert.equal(shouldSkipEchoConfirm("master", 10, opts), true);
  assert.equal(shouldSkipEchoConfirm("master", 1001, opts), false);
});

// ===== 3. エコー needle のタグ長オフセット =====

test("echoNeedle: タグ長ぶんオフセットして本文から照合する（実質5文字問題の解消）", () => {
  const tag = "[from:ebi-1] [reply] "; // compact 後 19 文字。
  const body = "タスクAの結果を報告します";
  const needle = echoNeedle(body, 24, tag);
  assert.ok(!needle.startsWith("["), "タグを針に含めない（本文から取る）");
  assert.ok(needle.length >= 12, `本文から十分な長さを照合する（実際: ${needle.length} 文字）`);
  assert.ok(body.startsWith(needle));
});

test("回帰: 同じエビの別メッセージの描画を到達と誤認しない（タグに食われた偽陽性）", () => {
  const tag = "[from:ebi-1] [reply] ";
  // 直前に描画された別メッセージ。旧実装は先頭 24 文字のうち 19 文字をタグに食われ、
  // 本文が数文字しか照合されないため、これを「到達」と誤判定しうる状態だった。
  const rendered = `ebi-control: ${tag}タスクAの結果を報告します`;
  assert.equal(containsEcho(rendered, "タスクAの結果を報告します", 24, tag), true, "本人の描画は到達と判定");
  assert.equal(
    containsEcho(rendered, "タスクBの調査結果をまとめました", 24, tag),
    false,
    "別本文を到達と誤認しない",
  );
});

test("echoNeedle: タグが長くても描画の切り詰め上限を超える針を作らない", () => {
  const longTag = "[from:very-long-agent-id-here] [reply] ";
  const body = "あ".repeat(100);
  const needle = echoNeedle(body, 24, longTag, 40);
  assert.ok(needle.length <= 40 - "[from:very-long-agent-id-here][reply]".length + 8);
  assert.ok(needle.length >= 8, "最低限の照合長は確保する");
});

// ===== 4. confirmed と queued の区別 =====

const busySpawnConfig: SpawnConfig = {
  command: "bash",
  args: ["-c", "cat"],
  // busy 判定を長めに保ち、「相手が作業中」を deterministic に作る。
  idleThresholdMs: 3000,
  scrollbackBytes: 64 * 1024,
  devChannelsAllowlist: [],
};
const handlers: AgentHandlers = { onData() {}, onStatus() {}, onExit() {}, onNotice() {} };
const launch = (cwd: string) => ({ command: "bash", args: ["-c", "cat"], cwd, model: null });

const registries: InstanceType<typeof Registry>[] = [];
function makeRegistry(mb: InstanceType<typeof Mailbox>, config = busySpawnConfig) {
  const r = new Registry(config, join(tmpdir(), `ebi-hardening-test-${registries.length}.json`), mb);
  registries.push(r);
  return r;
}
afterEach(() => {
  for (const r of registries.splice(0)) r.killAll();
});

test("回帰: busy で滞留した PTY 注入は confirmed:true を返さず queued として区別する", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  const agent = reg.spawn(".", handlers, { id: "master", launch: launch(".") });

  // idle のうちは即送信 → confirmed:true。
  const sent = await reg.deliver("master", "ebi-1", "いま送れる依頼");
  assert.equal(sent.via, "pty");
  assert.equal(sent.confirmed, true);
  assert.equal(sent.queued, false);

  // 出力を起こして busy にする（cat のエコーで idle タイマが再武装される）。
  agent.write("作業中の出力\n");
  await sleep(120);
  assert.equal(agent.getStatus(), "busy");

  const queued = await reg.deliver("master", "ebi-1", "busy 中に来た依頼");
  assert.equal(queued.ok, true);
  assert.equal(queued.via, "pty");
  assert.equal(queued.confirmed, false, "滞留を「到達確認済み」と偽らない（送信元への嘘を止める）");
  assert.equal(queued.queued, true);
  assert.equal(agent.pendingInjectCount(), 1);
});

test("resolveAndInject / reverseInject の details にも queued が載る", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  const agent = reg.spawn(".", handlers, { id: "master", launch: launch(".") });
  agent.write("作業中\n");
  await sleep(120);

  const res = await reg.resolveAndInject("master", "user", "busy 中の指示");
  assert.deepEqual(res.delivered, ["master"]);
  assert.equal(res.details[0]!.queued, true);
  assert.equal(res.details[0]!.confirmed, false);

  const rev = await reg.reverseInject("ebi-9", "master", "報告", "reply");
  assert.equal(rev.details[0]!.queued, true);
  assert.equal(rev.details[0]!.confirmed, false);
});

test("回帰: 滞留中の注入は agent 破棄時に無言で消さず記録して破棄する", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "ebi-delivery-log-"));
  const logFile = join(logDir, "delivery.log");
  configureDeliveryLog(logFile);
  try {
    const mb = new Mailbox();
    const reg = makeRegistry(mb);
    const agent = reg.spawn(".", handlers, { id: "ebi-1", launch: launch(".") });
    agent.write("作業中\n");
    await sleep(120);
    await reg.deliver("ebi-1", "master", "失われては困る本文");
    assert.equal(agent.pendingInjectCount(), 1);

    reg.remove("ebi-1");
    await flushDeliveryLog();
    const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const dropped = lines.find((l) => l.event === "dropped-inject-queue");
    assert.ok(dropped, "破棄した注入キューが恒久ログに残る（旧実装は警告すら出さなかった）");
    assert.equal(dropped.id, "ebi-1");
    assert.match(JSON.stringify(dropped.messages), /失われては困る本文/);
  } finally {
    configureDeliveryLog(null);
    rmSync(logDir, { recursive: true, force: true });
  }
});

// ===== 5. 配送ログの恒久化 =====

test("配送ログ: JSONL でファイルに残る / 無効化すると書かない", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "ebi-delivery-log-"));
  const logFile = join(logDir, "delivery.log");
  try {
    configureDeliveryLog(logFile);
    logDelivery({ event: "ack-timeout", msg: "テスト用の警告", id: "master", from: "ebi-1" });
    logDelivery({ event: "duplicate-subscriber", msg: "二重購読", id: "master", level: "warn" });
    await flushDeliveryLog();

    const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].event, "ack-timeout");
    assert.equal(lines[0].id, "master");
    assert.equal(lines[0].from, "ebi-1");
    assert.ok(Date.parse(lines[0].ts) > 0, "追跡できる時刻が入る");
    assert.equal(lines[1].event, "duplicate-subscriber");

    // 無効化後は書かれない（ユニットテスト等がファイルを汚さない）。
    configureDeliveryLog(null);
    logDelivery({ event: "ack-timeout", msg: "これは書かれない" });
    await flushDeliveryLog();
    assert.equal(readFileSync(logFile, "utf8").trim().split("\n").length, 2);
  } finally {
    configureDeliveryLog(null);
    rmSync(logDir, { recursive: true, force: true });
  }
});
