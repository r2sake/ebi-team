#!/usr/bin/env node
// PR-M11 実測用の偽 claude（**長いターン**を作るためだけのスタブ）。
// scripts/fake-claude-stream.mjs は 1 行 = 1 ターン即応答なので busy が一瞬しか続かない。
// ここでは「ターンが SLOW_MS 続く / その間に来た user 行は走行中ターンへ合流する（＝新ターンを
// 作らない）/ control_request interrupt で aborted 終端」という実 claude の挙動だけを模す。
//
// 判定用に stderr へ次を出す:
//   FAKE:USER <text>       … user 行を受けた
//   FAKE:JOIN <text>       … 走行中ターンへ合流した（＝ボスの busy 中送信が届いた）
//   FAKE:INTERRUPT         … 中断要求を受けた
import { createInterface } from "node:readline";

const SLOW_MS = Number(process.env.FAKE_SLOW_MS ?? 12000);
const SESSION_ID = "fake-slow-0001";
const MODEL = "claude-fake-1";
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const log = (s) => process.stderr.write(`${s}\n`);

out({
  type: "system",
  subtype: "init",
  session_id: SESSION_ID,
  model: MODEL,
  apiKeySource: "none",
  mcp_servers: [{ name: "ebi-control", status: "connected" }],
  capabilities: ["interrupt_receipt_v1"],
});

const textOf = (c) =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("")
      : "";

let timer = null; // 走行中ターンの終端タイマー（null なら idle）
let joined = 0;

function finish({ aborted }) {
  timer = null;
  joined = 0;
  if (aborted) {
    out({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
      session_id: SESSION_ID,
      total_cost_usd: 0.01,
      modelUsage: { [MODEL]: { contextWindow: 1_000_000 } },
    });
    return;
  }
  out({
    type: "assistant",
    session_id: SESSION_ID,
    message: {
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text: "長いターンが終わりました。" }],
      usage: { input_tokens: 10_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: SESSION_ID,
    total_cost_usd: 0.02,
    modelUsage: { [MODEL]: { contextWindow: 1_000_000 } },
  });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  if (raw?.type === "control_request") {
    log("FAKE:INTERRUPT");
    out({ type: "control_response", response: { request_id: raw.request_id, subtype: "success" } });
    if (timer) {
      clearTimeout(timer);
      finish({ aborted: true });
    }
    return;
  }
  if (raw?.type !== "user") return;
  const text = textOf(raw.message?.content);
  // replay ACK（--replay-user-messages 相当）。
  out({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text }] } });
  if (timer) {
    joined += 1;
    log(`FAKE:JOIN ${text.replace(/\n/g, " ")}`);
    return; // 走行中ターンへ合流（新しいターンは作らない）
  }
  log(`FAKE:USER ${text.replace(/\n/g, " ")}`);
  timer = setTimeout(() => finish({ aborted: false }), SLOW_MS);
});
