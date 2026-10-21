// busy のエビへの master 注入を「溜めずに作業中のターンへ差し込む」改修（codex の steer）の錠前。
//
// 守ること:
//   1. 判定の純関数 shouldSteerWhileBusy（backend・ready・送信元・先行キュー・guard）
//   2. codex backend のエビ: busy 中でも master の注入は "sent"（キューに積まない）
//   3. codex backend のエビ: master 以外からの注入は従来どおり "queued"
//   4. claude backend（既定）のエビ: busy 中の注入は従来どおり "queued"（挙動不変）
//   5. env EBI_BUSY_STEER=off で codex も従来動作へ戻る
//
// 実行: node --import tsx --test test/busySteer.test.ts

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

// ready 昇格を速くする（agent.ts はモジュール読込時に env を読む）。
process.env.EBI_MIN_BOOT_MS = "50";
process.env.EBI_CODEX_READY_WARMUP_MS = "1";
delete process.env.EBI_BUSY_STEER;

const { Agent, shouldSteerWhileBusy } = await import("../src/server/agent.ts");
import type { SpawnConfig, AgentHandlers } from "../src/server/agent.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const config: SpawnConfig = {
  command: "bash",
  args: ["-c", "cat"],
  // busy 判定を長めに保ち、「相手が作業中」を deterministic に作る。
  idleThresholdMs: 300,
  scrollbackBytes: 64 * 1024,
  devChannelsAllowlist: [],
};
const handlers: AgentHandlers = { onData() {}, onStatus() {}, onExit() {}, onNotice() {} };

const agents: InstanceType<typeof Agent>[] = [];
afterEach(() => {
  for (const a of agents.splice(0)) a.kill();
});

/** bash -c cat を指定 backend として起動し、ready まで進めてから busy にする。 */
async function busyAgent(backend: "codex" | "claude") {
  const agent = new Agent(
    `ebi-${backend}`,
    { command: "bash", args: ["-c", "cat"], cwd: ".", model: null, backend },
    config,
    handlers,
  );
  agents.push(agent);
  // codex は readyPattern（起動バナー）を見るまで ready にならない。cat のエコーで描かせる。
  if (backend === "codex") agent.write(">_ OpenAI Codex (v0.0.0)\n");
  const deadline = Date.now() + 5000;
  while (!agent.isReady() && Date.now() < deadline) await sleep(50);
  assert.equal(agent.isReady(), true, "ready に昇格すること");
  // 出力を起こして busy にする（cat のエコーで idle タイマが再武装される）。
  agent.write("作業中の出力\n");
  await sleep(80);
  assert.equal(agent.getStatus(), "busy");
  return agent;
}

const base = { steerWhileBusy: true, ready: true, from: "master", queueLength: 0, guarded: false };

test("shouldSteerWhileBusy: 条件がそろったときだけ true", () => {
  assert.equal(shouldSteerWhileBusy(base), true);
  assert.equal(shouldSteerWhileBusy({ ...base, steerWhileBusy: false }), false, "backend が非対応");
  assert.equal(shouldSteerWhileBusy({ ...base, ready: false }), false, "ready 前は入力欄が無い");
  assert.equal(shouldSteerWhileBusy({ ...base, from: "ebi-2" }), false, "master 以外は待たせる");
  assert.equal(shouldSteerWhileBusy({ ...base, from: "user" }), false);
  assert.equal(shouldSteerWhileBusy({ ...base, queueLength: 1 }), false, "先行キューを追い越さない");
  assert.equal(shouldSteerWhileBusy({ ...base, guarded: true }), false, "guard 付きはキューで再照合");
});

test("codex: busy 中でも master の注入は溜めずに送る", async () => {
  const agent = await busyAgent("codex");
  assert.equal(agent.inject("master", "訂正: 槍は右手で持つ", undefined, 42), "sent");
  assert.equal(agent.pendingInjectCount(), 0);
});

test("codex: master 以外からの注入は従来どおり溜める", async () => {
  const agent = await busyAgent("codex");
  assert.equal(agent.inject("ebi-2", "横からの通知"), "queued");
  assert.equal(agent.pendingInjectCount(), 1);
  // 先に溜まりがあれば master も追い越さずに後ろへ積む（順序を保つ）。
  assert.equal(agent.inject("master", "訂正"), "queued");
  assert.equal(agent.pendingInjectCount(), 2);
});

test("claude（既定）: busy 中の注入は従来どおり溜める（挙動不変）", async () => {
  const agent = await busyAgent("claude");
  assert.equal(agent.inject("master", "busy 中に来た依頼"), "queued");
  assert.equal(agent.pendingInjectCount(), 1);
});

test("EBI_BUSY_STEER=off で codex も従来どおり溜める", async () => {
  process.env.EBI_BUSY_STEER = "off";
  try {
    const agent = await busyAgent("codex");
    assert.equal(agent.inject("master", "訂正"), "queued");
    assert.equal(agent.pendingInjectCount(), 1);
  } finally {
    delete process.env.EBI_BUSY_STEER;
  }
});
