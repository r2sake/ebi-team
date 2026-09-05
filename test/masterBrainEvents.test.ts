// claude ヘッドレス（stream-json）NDJSON → MasterEvent 正規化の純関数テスト。
//
// 入力は PoC の実ログ（tmp/poc-m0/run1.excerpt.ndjson）から起こした実物の形。
// 守りたい不変条件（すべて PoC 実測で判明した罠）:
//  - system/init は毎ターン再送される → session イベントは 1 回だけ
//  - SessionStart hook 等の未知 system.subtype は捨てる（巨大本文を UI へ流さない）
//  - replay ACK と tool_result はどちらも type:"user" → text ブロック一致で分ける
//  - 文脈使用率は「ターン最後の assistant の usage」由来で**単調増加**する
//    （result.usage 由来だとツール往復のあるターンで跳ねて次ターンで下がる）
//  - 中断後の result（is_error:true）は「エラー」ではなく「中断」として出す
//
// 実行: node --import tsx --test test/masterBrainEvents.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ClaudeStreamNormalizer,
  computeContextUsage,
  extractContextWindow,
  isReplayAckFor,
  parseNdjsonLine,
  textBlocksOf,
} from "../src/server/master/claudeEvents.ts";
import type { MasterEvent } from "../src/server/master/brain.ts";

const CONTEXT_WINDOW = 1_000_000;

/** result イベント（PoC 実測の形。modelUsage に contextWindow が載る）。 */
function result(opts: {
  isError?: boolean;
  subtype?: string;
  terminalReason?: string | null;
  costUsd?: number;
  resultText?: string;
}): unknown {
  return {
    type: "result",
    subtype: opts.subtype ?? "success",
    is_error: opts.isError ?? false,
    result: opts.resultText ?? "ok",
    terminal_reason: opts.terminalReason ?? null,
    total_cost_usd: opts.costUsd ?? 0.1,
    // 非単調な値。**正規化はこれを見てはいけない**。
    usage: { input_tokens: 4, cache_read_input_tokens: 51_081, cache_creation_input_tokens: 604 },
    modelUsage: {
      "claude-opus-5": { contextWindow: CONTEXT_WINDOW, maxOutputTokens: 64_000 },
    },
  };
}

function assistantText(text: string, usage?: Record<string, number>): unknown {
  return {
    type: "assistant",
    message: {
      model: "claude-opus-5",
      content: [{ type: "text", text }],
      ...(usage ? { usage } : {}),
    },
  };
}

const initEvent = {
  type: "system",
  subtype: "init",
  session_id: "7055f9a3-5a16-43d6-b1d1-d07c52751f93",
  model: "claude-opus-5",
  permissionMode: "auto",
  apiKeySource: "none",
  mcp_servers: [{ name: "ebi-control", status: "connected" }],
  capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"],
};

function kinds(events: MasterEvent[]): string[] {
  return events.map((e) => e.kind);
}

test("parseNdjsonLine: 壊れた行と空行は null（読み捨てる）", () => {
  assert.equal(parseNdjsonLine(""), null);
  assert.equal(parseNdjsonLine('{"type":"assistant"'), null);
  assert.deepEqual(parseNdjsonLine('{"a":1}'), { a: 1 });
});

test("system/init は 1 回だけ session を出し、再送は捨てる", () => {
  const n = new ClaudeStreamNormalizer();
  const first = n.push(initEvent);
  assert.deepEqual(kinds(first), ["session"]);
  const ev = first[0];
  assert.equal(ev.kind === "session" && ev.apiKeySource, "none");
  assert.equal(ev.kind === "session" && ev.mcpServers[0].status, "connected");
  assert.deepEqual(n.push(initEvent), []); // 毎ターン再送されるぶん
  assert.equal(n.sessionId, initEvent.session_id);
  assert.equal(n.model, "claude-opus-5");
});

test("未知の system.subtype（SessionStart hook 等）は捨てる", () => {
  const n = new ClaudeStreamNormalizer();
  assert.deepEqual(
    n.push({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" }),
    [],
  );
  assert.deepEqual(n.push({ type: "system", subtype: "hook_response", body: "x".repeat(50_000) }), []);
  assert.deepEqual(n.push({ type: "system", subtype: "thinking_tokens", estimated_tokens: 12 }), []);
});

test("未知の type（rate_limit_event / control_response）は捨てる", () => {
  const n = new ClaudeStreamNormalizer();
  assert.deepEqual(n.push({ type: "rate_limit_event", rate_limit_info: {} }), []);
  assert.deepEqual(n.push({ type: "control_response", response: { subtype: "success" } }), []);
  assert.deepEqual(n.push({ type: "future_unknown_event" }), []);
  assert.deepEqual(n.push("not an object"), []);
});

test("assistant の text / thinking / tool_use が正規化される", () => {
  const n = new ClaudeStreamNormalizer();
  const out = n.push({
    type: "assistant",
    message: {
      model: "claude-opus-5",
      content: [
        { type: "thinking", thinking: "考える" },
        { type: "text", text: "答え" },
        { type: "tool_use", id: "toolu_1", name: "mcp__ebi-control__list_ebi", input: { a: 1 } },
      ],
    },
  });
  assert.deepEqual(kinds(out), ["thinking", "text", "toolCall"]);
  const call = out[2];
  assert.equal(call.kind === "toolCall" && call.name, "mcp__ebi-control__list_ebi");
  assert.deepEqual(call.kind === "toolCall" ? call.input : null, { a: 1 });
});

test("AskUserQuestion は question イベントへ射影される", () => {
  const n = new ClaudeStreamNormalizer();
  const out = n.push({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_q",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                header: "方針",
                question: "どちらにしますか?",
                multiSelect: false,
                options: [{ label: "A", description: "案A" }, { label: "B" }],
              },
            ],
          },
        },
      ],
    },
  });
  assert.deepEqual(kinds(out), ["question"]);
  const q = out[0];
  assert.ok(q.kind === "question");
  assert.equal(q.id, "toolu_q#0");
  assert.equal(q.header, "方針");
  assert.equal(q.multi, false);
  assert.deepEqual(q.options, [{ label: "A", description: "案A" }, { label: "B" }]);
});

test("AskUserQuestion の形が想定外なら通常ツールとして出す（黙って落とさない）", () => {
  const n = new ClaudeStreamNormalizer();
  const out = n.push({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t", name: "AskUserQuestion", input: {} }] },
  });
  assert.deepEqual(kinds(out), ["toolCall"]);
});

test("replay された user は ack、tool_result は toolResult（同じ type:\"user\"）", () => {
  const n = new ClaudeStreamNormalizer();
  const ack = n.push({
    type: "user",
    isReplay: true,
    message: { role: "user", content: [{ type: "text", text: "ターン1" }] },
  });
  assert.deepEqual(kinds(ack), ["ack"]);
  assert.equal(ack[0].kind === "ack" && ack[0].text, "ターン1");

  const tr = n.push({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "{}" }] },
      ],
    },
  });
  assert.deepEqual(kinds(tr), ["toolResult"]);
  assert.equal(tr[0].kind === "toolResult" && tr[0].id, "toolu_1");
  assert.equal(tr[0].kind === "toolResult" && tr[0].ok, true);
});

test("tool_result の is_error は ok:false になる", () => {
  const n = new ClaudeStreamNormalizer();
  const out = n.push({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "t", is_error: true, content: "boom" }],
    },
  });
  assert.equal(out[0].kind === "toolResult" && out[0].ok, false);
  assert.equal(out[0].kind === "toolResult" && out[0].content, "boom");
});

test("中断マーカー [Request interrupted by user] は UI へ流さない", () => {
  const n = new ClaudeStreamNormalizer();
  assert.deepEqual(
    n.push({
      type: "user",
      message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
    }),
    [],
  );
});

test("isReplayAckFor: text 一致で照合し tool_result を弾く", () => {
  const raw = {
    type: "user",
    isReplay: true,
    message: { content: [{ type: "text", text: "[reply] 完了しました" }] },
  };
  assert.equal(isReplayAckFor(raw, "[reply] 完了しました"), true);
  assert.equal(isReplayAckFor(raw, "別の本文"), false);
  assert.equal(
    isReplayAckFor(
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t" }] } },
      "",
    ),
    false,
  );
  assert.equal(isReplayAckFor({ type: "assistant", message: { content: [] } }, ""), false);
});

test("textBlocksOf は素の文字列 content も扱える", () => {
  assert.equal(textBlocksOf("そのまま"), "そのまま");
  assert.equal(textBlocksOf([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "ab");
  assert.equal(textBlocksOf(null), "");
});

test("stream_event の text_delta / thinking_delta は partial:true で出る", () => {
  const n = new ClaudeStreamNormalizer();
  const t = n.push({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "あ" } },
  });
  assert.equal(t[0].kind === "text" && t[0].partial, true);
  const th = n.push({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "…" } },
  });
  assert.equal(th[0].kind === "thinking" && th[0].partial, true);
  assert.deepEqual(
    n.push({ type: "stream_event", event: { type: "message_start", message: {} } }),
    [],
  );
});

test("extractContextWindow: modelUsage[model].contextWindow を拾う", () => {
  assert.equal(extractContextWindow(result({}), "claude-opus-5"), CONTEXT_WINDOW);
  // モデル名が特定できない場合は載っている最大の窓で代用する
  assert.equal(extractContextWindow(result({}), null), CONTEXT_WINDOW);
  assert.equal(extractContextWindow({ type: "result" }, "claude-opus-5"), null);
});

test("computeContextUsage: input + cache_read + cache_creation（output は含めない）", () => {
  const u = computeContextUsage(
    {
      input_tokens: 2,
      output_tokens: 999,
      cache_read_input_tokens: 10_014,
      cache_creation_input_tokens: 15_412,
    },
    CONTEXT_WINDOW,
  );
  assert.equal(u.contextTokens, 25_428);
  assert.equal(u.contextSize, CONTEXT_WINDOW);
  assert.equal(u.contextUsedPct, 2.5);
  assert.equal(u.output, 999);
});

test("computeContextUsage: 欠測は null（0 と区別する）", () => {
  const u = computeContextUsage(null, CONTEXT_WINDOW);
  assert.equal(u.contextTokens, null);
  assert.equal(u.contextUsedPct, null);
  assert.equal(computeContextUsage({ input_tokens: 1 }, null).contextUsedPct, null);
});

test("文脈使用率はターンを跨いで単調増加する（PoC 実測の usage 列で確認）", () => {
  const n = new ClaudeStreamNormalizer();
  n.push(initEvent);
  // PoC run1 の実測値: 25,428 → 25,498 →（ツール往復 25,587 を挟んで）26,102 → 26,272
  const turns: { assistants: Record<string, number>[] }[] = [
    { assistants: [{ input_tokens: 2, cache_read_input_tokens: 10_014, cache_creation_input_tokens: 15_412 }] },
    { assistants: [{ input_tokens: 2, cache_read_input_tokens: 25_426, cache_creation_input_tokens: 70 }] },
    {
      assistants: [
        // ツール呼び出しの assistant（ターン途中）
        { input_tokens: 2, cache_read_input_tokens: 25_496, cache_creation_input_tokens: 89 },
        // ターン最後の assistant（これが正しい観測値）
        { input_tokens: 2, cache_read_input_tokens: 25_585, cache_creation_input_tokens: 515 },
      ],
    },
    { assistants: [{ input_tokens: 2, cache_read_input_tokens: 26_100, cache_creation_input_tokens: 170 }] },
  ];

  const observed: number[] = [];
  for (const turn of turns) {
    for (const usage of turn.assistants) n.push(assistantText("ok", usage));
    const out = n.push(result({}));
    const end = out[0];
    assert.ok(end.kind === "turnEnd");
    assert.ok(end.usage?.contextTokens != null);
    observed.push(end.usage.contextTokens);
  }

  assert.deepEqual(observed, [25_428, 25_498, 26_102, 26_272]);
  for (let i = 1; i < observed.length; i++) {
    assert.ok(observed[i] >= observed[i - 1], `単調でない: ${observed[i - 1]} → ${observed[i]}`);
  }
  // result.usage（= 51,689）を見ていたらこの値にはならない＝非単調な経路を踏んでいない証拠。
  assert.notEqual(observed[2], 51_689);
});

test("assistant の無いターン（即中断）でも直前の文脈値を落とさない", () => {
  const n = new ClaudeStreamNormalizer();
  n.push(initEvent);
  n.push(assistantText("ok", { input_tokens: 2, cache_read_input_tokens: 26_000, cache_creation_input_tokens: 0 }));
  n.push(result({}));
  const out = n.push(result({ isError: true, terminalReason: "aborted_streaming" }));
  assert.equal(out[0].kind === "turnEnd" && out[0].usage?.contextTokens, 26_002);
});

test("turnEnd: 正常終了は ok:true / aborted:false / コストが載る", () => {
  const n = new ClaudeStreamNormalizer();
  n.push(initEvent);
  const out = n.push(result({ costUsd: 0.247826 }));
  const end = out[0];
  assert.ok(end.kind === "turnEnd");
  assert.equal(end.ok, true);
  assert.equal(end.aborted, false);
  assert.equal(end.costUsd, 0.247826);
  assert.equal(end.errorText, null);
});

test("中断後の result はエラーではなく中断として出る（terminal_reason 由来）", () => {
  const n = new ClaudeStreamNormalizer();
  n.push(initEvent);
  const out = n.push(
    result({
      isError: true,
      subtype: "error_during_execution",
      terminalReason: "aborted_streaming",
      resultText: "undefined",
    }),
  );
  const end = out[0];
  assert.ok(end.kind === "turnEnd");
  assert.equal(end.ok, false);
  assert.equal(end.aborted, true);
  assert.equal(end.errorText, null); // 通常エラー通知に化けさせない
});

test("interrupt 送信済みなら terminal_reason が無くても中断扱い", () => {
  const n = new ClaudeStreamNormalizer();
  n.push(initEvent);
  n.markInterruptRequested();
  const out = n.push(result({ isError: true, subtype: "error_during_execution" }));
  assert.equal(out[0].kind === "turnEnd" && out[0].aborted, true);
  // フラグは 1 回で消える（次の本物のエラーを中断に化けさせない）
  const next = n.push(result({ isError: true, subtype: "error_during_execution", resultText: "boom" }));
  assert.equal(next[0].kind === "turnEnd" && next[0].aborted, false);
  assert.equal(next[0].kind === "turnEnd" && next[0].errorText, "boom");
});

test("本物のエラーは errorText を持つ", () => {
  const n = new ClaudeStreamNormalizer();
  const out = n.push(result({ isError: true, subtype: "error_max_turns", resultText: "限界" }));
  const end = out[0];
  assert.ok(end.kind === "turnEnd");
  assert.equal(end.ok, false);
  assert.equal(end.aborted, false);
  assert.equal(end.errorText, "限界");
});
