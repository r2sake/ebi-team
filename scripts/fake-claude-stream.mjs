#!/usr/bin/env node
// 偽 claude（stream-json ヘッドレス）。**実 claude を起動せずに** chat モードの master 経路を
// 端から端まで動かすためのテスト用スタブ。サブスク枠も課金も一切消費しない。
//
// 使い方: 実行属性付きで `claude` という名前のファイルとして PATH の先頭に置く
//   （scripts/e2e-context-guard.mjs がそうしている）。ClaudeHeadlessBrain は
//   `spawn("claude", args)` なので PATH 解決でこちらが起動する。
//
// 対応している範囲（PR-M6 の e2e に要るものだけ）:
//  - 起動時に `system/init`（apiKeySource:"none" ＝ preflight を通る形）を 1 回出す
//  - stdin の `{"type":"user",...}` 1 行につき 1 ターン返す:
//      replay ACK（isReplay:true の user）→ assistant(text, message.usage) → result
//  - 本文に `ctx:<数値>` が含まれていたら、その % になるよう assistant の usage を作る
//    （contextWindow は result.modelUsage で 1,000,000 と申告する）
//  - 本文に `rate:<5h の割合>,<週次の割合>` が含まれていたら `rate_limit_event` を 1 本出す
//    （utilization は 0〜1 の割合。src/server/master/rateLimit.ts の実測どおり）
//  - `{"type":"control_request",...interrupt}` には control_response を返す
//
// 実 claude を模すのはここまで（ツール実行・承認・partial は出さない）。

import { createInterface } from "node:readline";

const SESSION_ID = process.env.FAKE_CLAUDE_SESSION_ID ?? "fake-session-0001";
const MODEL = "claude-fake-1";
const CONTEXT_WINDOW = 1_000_000;

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

out({
  type: "system",
  subtype: "init",
  session_id: SESSION_ID,
  model: MODEL,
  apiKeySource: "none",
  mcp_servers: [{ name: "ebi-control", status: "connected" }],
  capabilities: ["interrupt_receipt_v1"],
});

/** content ブロック配列（or 文字列）から text を連結する。 */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
}

let costTotal = 0;
// 直近の文脈% を保持する（`ctx:` の指定が無いターンは前回値を維持＝単調に見せる）。
let lastPct = Number(process.env.FAKE_CLAUDE_INITIAL_CTX_PCT ?? 1);

function turn(text) {
  // 1) replay ACK（--replay-user-messages 相当）。MasterSession の send() が待っている。
  out({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text }] } });

  // 2) 枠（rate_limit_event）。指定があったときだけ。
  const rate = /rate:([0-9.]+),([0-9.]+)/.exec(text);
  if (rate) {
    out({
      type: "rate_limit_event",
      rate_limit_info: {
        unifiedWindows: {
          five_hour: { utilization: Number(rate[1]), resetsAt: 1788588600 },
          seven_day: { utilization: Number(rate[2]), resetsAt: 1789030800 },
        },
      },
    });
  }

  // 3) assistant 本文 + message.usage（文脈占有量の唯一の供給源）。
  const m = /ctx:([0-9.]+)/.exec(text);
  if (m) lastPct = Number(m[1]);
  const pct = lastPct;
  const contextTokens = Math.round((pct / 100) * CONTEXT_WINDOW);
  out({
    type: "assistant",
    message: {
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text: `了解（ctx ${pct}%）` }],
      usage: {
        input_tokens: contextTokens,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });

  // 4) result（ターン終端）。modelUsage で文脈窓を申告する。
  costTotal += 0.01;
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: SESSION_ID,
    total_cost_usd: Number(costTotal.toFixed(4)),
    modelUsage: { [MODEL]: { contextWindow: CONTEXT_WINDOW } },
  });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  if (raw?.type === "control_request") {
    out({ type: "control_response", response: { request_id: raw.request_id, subtype: "success" } });
    return;
  }
  if (raw?.type !== "user") return;
  turn(textOf(raw.message?.content));
});
rl.on("close", () => process.exit(0));
