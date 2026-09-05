// ClaudeHeadlessBrain の「イベントストリーム側」のテスト。
// **実プロセスは起動しない**（ingestLineForTest で NDJSON を直接食わせる）。
// 実プロセスを立てる結合確認は opt-in の scripts/e2e-master-brain.mjs 側（既定では走らせない）。
//
// 実行: node --import tsx --test test/masterBrainStream.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeHeadlessBrain } from "../src/server/master/claudeBrain.ts";
import type { MasterEvent } from "../src/server/master/brain.ts";

/** ストリームから n 件取り出す。 */
async function take(brain: ClaudeHeadlessBrain, n: number): Promise<MasterEvent[]> {
  const out: MasterEvent[] = [];
  for await (const ev of brain.events()) {
    out.push(ev);
    if (out.length >= n) break;
  }
  return out;
}

const INIT_LINE = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "sess-1",
  model: "claude-opus-5",
  apiKeySource: "none",
  mcp_servers: [{ name: "ebi-control", status: "connected" }],
  capabilities: ["interrupt_receipt_v1"],
});

test("正規化済みイベントがストリームへ流れ、sessionId が取れる", async () => {
  const brain = new ClaudeHeadlessBrain();
  brain.ingestLineForTest(INIT_LINE);
  brain.ingestLineForTest(
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "はい" }] } }),
  );
  const events = await take(brain, 2);
  assert.equal(events[0].kind, "session");
  assert.equal(events[1].kind === "text" && events[1].text, "はい");
  assert.equal(brain.sessionId(), "sess-1");
});

test("replay ACK は UI ストリームへ流さない（send() の返り値で伝える）", async () => {
  const brain = new ClaudeHeadlessBrain();
  brain.ingestLineForTest(
    JSON.stringify({
      type: "user",
      isReplay: true,
      message: { content: [{ type: "text", text: "[reply] 完了" }] },
    }),
  );
  brain.ingestLineForTest(
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "了解" }] } }),
  );
  const events = await take(brain, 1);
  assert.equal(events[0].kind, "text"); // ack は挟まらない
});

test("apiKeySource が none 以外なら error notice を出す（従量課金の検出）", async () => {
  const brain = new ClaudeHeadlessBrain();
  brain.ingestLineForTest(
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "s",
      model: "claude-opus-5",
      apiKeySource: "ANTHROPIC_API_KEY",
      mcp_servers: [],
    }),
  );
  const events = await take(brain, 2);
  assert.equal(events[0].kind, "notice");
  assert.equal(events[0].kind === "notice" && events[0].level, "error");
  assert.match(events[0].kind === "notice" ? events[0].text : "", /apiKeySource/);
  assert.equal(events[1].kind, "session");
});

test("turnEnd のコストがプロセス単位レジャへ記録される", async () => {
  const brain = new ClaudeHeadlessBrain();
  brain.ingestLineForTest(INIT_LINE);
  brain.ingestLineForTest(
    JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.25 }),
  );
  await take(brain, 2);
  assert.equal(brain.costLedger.processCount, 1);
  assert.equal(brain.costLedger.total(), 0.25);
});

test("起動前に send / interrupt しても壊れない", async () => {
  const brain = new ClaudeHeadlessBrain();
  await assert.rejects(() => brain.send({ text: "x" }), /起動していません/);
  await brain.interrupt(); // 未起動なら黙って何もしない
  await brain.stop();
});

test("未知の id への answer は明示エラー（黙って握り潰さない）", async () => {
  const brain = new ClaudeHeadlessBrain();
  await assert.rejects(() => brain.answer("id", { allow: true }), /見つかりません/);
});
