// Registry の配送（deliver / resolveAndInject / reverseInject）の到達確認・フォールバックを、
// 実 PTY エージェント（bash cat・実 claude 不要）で deterministic に検証する統合テスト。
//
// これは 2026-07-20 のインシデント（master 宛が「delivered と報告されるのに実際は届かない」）の
// 根治の回帰ガードである。核心:
//   - 過去に購読したが今は notify が通らない相手（liveness 切れ）へは、黙って mailbox に
//     push して delivered を返すのではなく PTY 注入へフォールバックする（via:"pty"）。
//   - notify を試みて ACK が取れなければ PTY へフォールバックする（via:"pty-fallback"）。
//   - ACK が取れたときだけ notify 到達確認（via:"notify"）とする。
//   - notifySubscribe:false は常に PTY。
//
// 実行: node --import tsx --test test/delivery.test.ts

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

// deliver の ACK 待ちタイムアウトを短くしてテストを速くする（registry.ts はモジュール読込時に
// この env を読むので、動的 import より前に設定する）。
process.env.EBI_DELIVER_ACK_TIMEOUT_MS = "300";
delete process.env.EBI_INJECT_MODE; // notify モード（既定）で検証する。

const { Registry } = await import("../src/server/registry.ts");
const { Mailbox } = await import("../src/server/mailbox.ts");
import type { SpawnConfig, AgentHandlers } from "../src/server/agent.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const spawnConfig: SpawnConfig = {
  command: "bash",
  args: ["-c", "cat"],
  idleThresholdMs: 150,
  scrollbackBytes: 64 * 1024,
  devChannelsAllowlist: [],
};
const handlers: AgentHandlers = {
  onData() {},
  onStatus() {},
  onExit() {},
  onNotice() {},
};

const launch = (cwd: string) => ({ command: "bash", args: ["-c", "cat"], cwd, model: null });

// 各テストで生成した Registry を後始末する（PTY を残さない）。
const registries: InstanceType<typeof Registry>[] = [];
function makeRegistry(mb: InstanceType<typeof Mailbox>) {
  const dump = join(tmpdir(), `ebi-delivery-test-${registries.length}.json`);
  const r = new Registry(spawnConfig, dump, mb);
  registries.push(r);
  return r;
}
afterEach(() => {
  for (const r of registries.splice(0)) r.killAll();
});

test("回帰: 購読が live でない相手へは黙って消さず PTY へフォールバックする（インシデント本丸）", async () => {
  // liveness window を極小にして「過去に購読したが今は dead」を作る。
  const mb = new Mailbox(30);
  const reg = makeRegistry(mb);
  const agent = reg.spawn(".", handlers, { id: "master", launch: launch(".") });

  // 一度だけ購読 → 直後に window を過ぎて dead 化（everSubscribed は true のまま）。
  await mb.subscribe("master", 1);
  await sleep(50);
  assert.equal(mb.everSubscribed("master"), true, "過去に購読済み（旧実装ならここで notify に載せて消えた）");
  assert.equal(reg.hasActiveSubscriber("master"), false, "現在は live でない");

  const out = await reg.deliver("master", "ebi-1", "大事な依頼");
  assert.equal(out.ok, true);
  assert.equal(out.via, "pty", "dead 購読へは notify に載せず PTY 注入する");
  assert.equal(out.confirmed, true);
  // notify 経路には積まれていない（黙って mailbox で腐らない）。
  assert.equal(mb.pendingCount("master"), 0);
  assert.ok(agent);
});

test("live + ACK あり → notify 到達確認（via:notify・PTY へは載せない）", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  reg.spawn(".", handlers, { id: "ebi-1", launch: launch(".") });

  // ブリッジ役: 購読し、届いたメッセージを即 ack する（notification emit 後の ACK を模す）。
  let acked: number[] = [];
  const bridge = (async () => {
    const msgs = await mb.subscribe("ebi-1", 2000);
    acked = msgs.map((m) => m.id);
    mb.ack("ebi-1", acked);
  })();

  const out = await reg.deliver("ebi-1", "master", "疎通");
  await bridge;
  assert.equal(out.via, "notify");
  assert.equal(out.confirmed, true);
  assert.equal(acked.length, 1, "ブリッジが 1 件受け取って ack した");
  assert.equal(mb.pendingCount("ebi-1"), 0);
});

test("live だが ACK が来ない → PTY フォールバック（via:pty-fallback）し pending を回収する", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  reg.spawn(".", handlers, { id: "ebi-1", launch: launch(".") });

  // live にするため一度購読して打刻（ただし ack を返すブリッジは動かさない＝転送不能を模す）。
  await mb.subscribe("ebi-1", 1);
  assert.equal(reg.hasActiveSubscriber("ebi-1"), true);

  const out = await reg.deliver("ebi-1", "master", "ACK 来ない");
  assert.equal(out.via, "pty-fallback", "ACK タイムアウトで PTY へフォールバック");
  assert.equal(out.confirmed, true);
  // フォールバック時に pending から回収済み（二重配送しない）。
  assert.equal(mb.pendingCount("ebi-1"), 0);
});

test("notifySubscribe:false は live でも常に PTY 注入", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  reg.spawn(".", handlers, { id: "mina", launch: launch("."), notifySubscribe: false });
  await mb.subscribe("mina", 1); // live にしても…

  const out = await reg.deliver("mina", "master", "外部チャンネル待機セッション");
  assert.equal(out.via, "pty");
  assert.equal(mb.pendingCount("mina"), 0);
});

test("agent 不在は ok:false / via:none", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  const out = await reg.deliver("nobody", "master", "x");
  assert.equal(out.ok, false);
  assert.equal(out.via, "none");
  assert.equal(out.confirmed, false);
});

test("resolveAndInject は details（via/confirmed）を返す", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  reg.spawn(".", handlers, { id: "ebi-1", launch: launch(".") });

  const res = await reg.resolveAndInject("ebi-1", "user", "hi");
  assert.deepEqual(res.delivered, ["ebi-1"]);
  assert.equal(res.details.length, 1);
  assert.equal(res.details[0]!.id, "ebi-1");
  assert.equal(res.details[0]!.via, "pty"); // 購読 live でないので PTY
});

test("reverseInject も details を返す（エビ → master 経路）", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  reg.spawn(".", handlers, { id: "master", launch: launch(".") });

  const res = await reg.reverseInject("ebi-1", "master", "報告", "reply");
  assert.deepEqual(res.delivered, ["master"]);
  assert.equal(res.details[0]!.via, "pty");
  assert.equal(res.details[0]!.confirmed, true);
});

test("@all ブロードキャストは connected 各宛先の details を返し isolated を除く", async () => {
  const mb = new Mailbox();
  const reg = makeRegistry(mb);
  reg.spawn(".", handlers, { id: "ebi-1", launch: launch(".") });
  reg.spawn(".", handlers, { id: "ebi-2", launch: launch(".") });
  reg.setMode("ebi-2", "isolated");

  const res = await reg.resolveAndInject("all", "master", "全員へ");
  assert.deepEqual(res.delivered, ["ebi-1"], "isolated は配信対象外");
  assert.equal(res.details.length, 1);
  assert.equal(res.details[0]!.id, "ebi-1");
});
