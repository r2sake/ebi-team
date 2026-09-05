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
//  - 本文に `perm:<ツール名>:<コマンド>` があれば、tool_use を出したうえで
//    `POST $EBI_CONTROL_URL/control/chat-permission` を叩き、**応答が返るまでターンを止める**
//    （実 claude の --permission-prompt-tool → 制御MCP → 制御API と同じ経路を叩く。
//     違うのは「MCP ブリッジを挟まない」ことだけ）
//  - 本文に `ask:<質問>|<選択肢1>,<選択肢2>` があれば AskUserQuestion の承認要求を同じ口へ出し、
//    返ってきた `updatedInput.answers` を tool_result にして復唱する
//
// 実 claude を模すのはここまで（partial は出さない）。

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

const CONTROL_URL = (process.env.EBI_CONTROL_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

/** 承認要求を制御API へ投げ、決定（{behavior,...}）が返るまで待つ。 */
async function askPermission(toolName, input, toolUseId) {
  const res = await fetch(`${CONTROL_URL}/control/chat-permission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool_name: toolName, input, tool_use_id: toolUseId }),
  });
  if (!res.ok) return { behavior: "deny", message: `HTTP ${res.status}` };
  return res.json();
}

let toolSeq = 0;
// プロセスを跨いで id が衝突しないように pid を混ぜる（実 claude の tool_use_id も一意）。
const nextToolId = () => `toolu_fake_${process.pid}_${++toolSeq}`;

/** 承認が要るツール実行 1 回分（tool_use → 承認待ち → tool_result）。 */
async function runPermissionedTool(toolName, command) {
  const id = nextToolId();
  out({
    type: "assistant",
    message: {
      role: "assistant",
      model: MODEL,
      content: [{ type: "tool_use", id, name: toolName, input: { command } }],
    },
  });
  const decision = await askPermission(toolName, { command }, id);
  const allowed = decision?.behavior === "allow";
  out({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: !allowed,
          content: allowed ? `実行しました: ${command}` : `拒否されました: ${decision?.message ?? ""}`,
        },
      ],
    },
  });
  return allowed;
}

/** AskUserQuestion 1 回分（tool_use → 回答待ち → tool_result）。 */
async function runAskUserQuestion(question, options) {
  const id = nextToolId();
  const input = {
    questions: [
      { question, header: "確認", multiSelect: false, options: options.map((label) => ({ label })) },
    ],
  };
  out({ type: "assistant", message: { role: "assistant", model: MODEL, content: [{ type: "tool_use", id, name: "AskUserQuestion", input }] } });
  const decision = await askPermission("AskUserQuestion", input, id);
  const answers = decision?.behavior === "allow" ? (decision.updatedInput?.answers ?? {}) : {};
  const answer = answers[question];
  out({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: false,
          content: answer
            ? `Your questions have been answered: "${question}"="${answer}".`
            : "The user did not answer the questions.",
        },
      ],
    },
  });
  return answer ?? null;
}

let costTotal = 0;
// 直近の文脈% を保持する（`ctx:` の指定が無いターンは前回値を維持＝単調に見せる）。
let lastPct = Number(process.env.FAKE_CLAUDE_INITIAL_CTX_PCT ?? 1);

async function turn(text) {
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

  // 2.5) 承認が要るツール / 質問（PR-M5）。応答が返るまでここでターンが止まる。
  const notes = [];
  const perm = /perm:([A-Za-z_]+):([^\n]+)/.exec(text);
  if (perm) {
    const allowed = await runPermissionedTool(perm[1], perm[2].trim());
    notes.push(allowed ? "TOOL_RAN" : "TOOL_BLOCKED");
  }
  const ask = /ask:([^|\n]+)\|([^\n]+)/.exec(text);
  if (ask) {
    const answer = await runAskUserQuestion(ask[1].trim(), ask[2].split(",").map((s) => s.trim()));
    notes.push(answer ? `ANSWER=${answer}` : "NO_ANSWER");
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
      content: [{ type: "text", text: `了解（ctx ${pct}%）${notes.length > 0 ? ` ${notes.join(" ")}` : ""}` }],
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

// ターンは 1 本ずつ直列に回す（承認待ちで await するため、後続行が割り込むと順序が壊れる）。
let chain = Promise.resolve();

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
  const text = textOf(raw.message?.content);
  chain = chain.then(() => turn(text)).catch((err) => {
    process.stderr.write(`fake-claude: ターンで例外: ${err?.message ?? err}\n`);
  });
});
rl.on("close", () => process.exit(0));
