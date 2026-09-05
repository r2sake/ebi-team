#!/usr/bin/env node
// PR-M11（返信/引用）実測用の偽 claude。**受け取った本文をそのまま復唱する**だけ。
// これで「master の CLI に何が届いたか」を画面から確認できる
//（引用ヘッダ `> [reply to master#<seq>] …` が本文の先頭に載っているか）。
import { createInterface } from "node:readline";

const SESSION_ID = "fake-echo-0001";
const MODEL = "claude-fake-1";
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

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

createInterface({ input: process.stdin }).on("line", (line) => {
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
  out({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text }] } });
  // 復唱（markdown の引用記法にならないよう、行頭の `>` は `RECV|` に置き換えて出す）。
  const echoed = text.split("\n").map((l) => `RECV| ${l}`).join("\n");
  out({
    type: "assistant",
    session_id: SESSION_ID,
    message: {
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text: echoed }],
      usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: SESSION_ID,
    total_cost_usd: 0.01,
    modelUsage: { [MODEL]: { contextWindow: 1_000_000 } },
  });
});
