// master チャット UI（PR-M3）の表示モデルのテスト。
// DOM には依存しない純関数/純クラス（src/client/chatModel.ts）だけを検証する
// （DOM 側 chat.ts の実画面確認は Playwright スクショ・tmp/shots-m3/）。
//
// 実行: node --import tsx --test test/masterChatUi.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ChatTranscript,
  formatContextPct,
  formatCost,
  oneLine,
  stateLabel,
  summarizeToolInput,
} from "../src/client/chatModel.ts";
import type { MasterChatEnvelope, MasterChatEvent } from "../src/shared/protocol.ts";

let seq = 0;
function env(event: MasterChatEvent): MasterChatEnvelope {
  seq += 1;
  return { seq, ts: 1_700_000_000_000 + seq, event };
}
function fresh(): ChatTranscript {
  seq = 0;
  return new ChatTranscript();
}

test("partial の逐次描画: 差分は追記され、全文が来たら置き換えて閉じる", () => {
  const t = fresh();
  t.apply(env({ kind: "text", text: "こん", partial: true }));
  t.apply(env({ kind: "text", text: "にちは", partial: true }));
  assert.equal(t.items.length, 1);
  assert.deepEqual(
    t.items[0],
    { kind: "assistant", seq: 1, ts: 1_700_000_000_001, text: "こんにちは", streaming: true },
  );

  // ブロック完了時の全文（partial:false）で置換され、streaming が閉じる。
  t.apply(env({ kind: "text", text: "こんにちは、ボス。", partial: false }));
  assert.equal(t.items.length, 1);
  const item = t.items[0]!;
  assert.equal(item.kind === "assistant" && item.text, "こんにちは、ボス。");
  assert.equal(item.kind === "assistant" && item.streaming, false);
});

test("partial 無し（PR-M2 相当）でも 1 発話 1 アイテムになる", () => {
  const t = fresh();
  t.apply(env({ kind: "text", text: "A", partial: false }));
  t.apply(env({ kind: "text", text: "B", partial: false }));
  assert.equal(t.items.length, 2);
});

test("thinking は text と別アイテムになり、種別が変わったら streaming を閉じる", () => {
  const t = fresh();
  t.apply(env({ kind: "thinking", text: "考え中", partial: true }));
  t.apply(env({ kind: "text", text: "答え", partial: true }));
  assert.equal(t.items.length, 2);
  assert.equal(t.items[0]!.kind, "thinking");
  assert.equal(t.items[0]!.kind === "thinking" && t.items[0]!.streaming, false);
  assert.equal(t.items[1]!.kind, "assistant");
});

test("toolCall と toolResult は同じ 1 アイテムに畳まれる", () => {
  const t = fresh();
  const call = t.apply(env({ kind: "toolCall", id: "tu_1", name: "Bash", input: { command: "ls -la" } }));
  assert.deepEqual(call, { touched: [0], appendedFrom: 0 });
  assert.equal(t.items[0]!.kind === "tool" && t.items[0]!.state, "running");

  const result = t.apply(env({ kind: "toolResult", id: "tu_1", ok: true, content: "a\nb" }));
  // 追加ではなく既存 index の更新（DOM 側はここだけ描き直す）。
  assert.deepEqual(result, { touched: [0], appendedFrom: -1 });
  assert.equal(t.items.length, 1);
  const tool = t.items[0]!;
  assert.equal(tool.kind === "tool" && tool.state, "ok");
  assert.equal(tool.kind === "tool" && tool.result, "a\nb");
});

test("対応する toolCall が無い toolResult も捨てずに単独アイテムで出す", () => {
  const t = fresh();
  t.apply(env({ kind: "toolResult", id: "tu_x", ok: false, content: "失敗" }));
  assert.equal(t.items.length, 1);
  assert.equal(t.items[0]!.kind === "tool" && t.items[0]!.state, "error");
});

test("inbound（エビ返信）は from / tag つきの別アイテムになる", () => {
  const t = fresh();
  t.apply(env({ kind: "inbound", from: "ebi-3", tag: "reply", text: "PR 出しました" }));
  t.apply(env({ kind: "inbound", from: "ebi-3", tag: "idle", text: "" }));
  assert.equal(t.items[0]!.kind === "inbound" && t.items[0]!.tag, "reply");
  assert.equal(t.items[1]!.kind === "inbound" && t.items[1]!.from, "ebi-3");
});

test("turnEnd でコストと文脈% がヘッダ用サマリへ反映される", () => {
  const t = fresh();
  t.apply(env({ kind: "session", sessionId: "s1", model: "opus", apiKeySource: "none", mcpServers: [], capabilities: [] }));
  t.apply(
    env({
      kind: "turnEnd",
      ok: true,
      aborted: false,
      usage: {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheCreation: 40,
        contextTokens: 80,
        contextSize: 1_000_000,
        contextUsedPct: 31.4,
      },
      costUsd: 0.1,
      totalCostUsd: 1.25,
      errorText: null,
    }),
  );
  assert.deepEqual(t.summary, { model: "opus", totalCostUsd: 1.25, contextUsedPct: 31.4 });
  assert.equal(formatCost(t.summary.totalCostUsd), "$1.25");
  assert.equal(formatContextPct(t.summary.contextUsedPct), "31%");
});

test("turnEnd は開いたままの streaming を閉じる（中断ターンでカーソルが残らない）", () => {
  const t = fresh();
  t.apply(env({ kind: "text", text: "途中まで", partial: true }));
  t.apply(
    env({ kind: "turnEnd", ok: false, aborted: true, usage: null, costUsd: null, totalCostUsd: null, errorText: null }),
  );
  assert.equal(t.items[0]!.kind === "assistant" && t.items[0]!.streaming, false);
  assert.equal(t.items[1]!.kind === "turnEnd" && t.items[1]!.aborted, true);
});

test("usage が取れない backend では文脈% を「—」にし、直前の値を消さない", () => {
  const t = fresh();
  t.apply(
    env({
      kind: "turnEnd",
      ok: true,
      aborted: false,
      usage: { input: null, output: null, cacheRead: null, cacheCreation: null, contextTokens: null, contextSize: null, contextUsedPct: null },
      costUsd: null,
      totalCostUsd: null,
      errorText: null,
    }),
  );
  assert.equal(formatContextPct(t.summary.contextUsedPct), "—");
  assert.equal(formatCost(t.summary.totalCostUsd), "—");
});

test("適用済み seq の再配信は捨てる（snapshot と live の重なり）", () => {
  const t = fresh();
  const a = env({ kind: "user", text: "やあ" });
  assert.deepEqual(t.apply(a), { touched: [0], appendedFrom: 0 });
  assert.deepEqual(t.apply(a), { touched: [], appendedFrom: -1 });
  assert.equal(t.items.length, 1);
});

test("snapshot の reset は状態ごと作り直す（再接続で二重表示しない）", () => {
  const t = fresh();
  const envelopes = [env({ kind: "user", text: "1 通目" }), env({ kind: "text", text: "返事", partial: false })];
  t.reset(envelopes);
  assert.equal(t.items.length, 2);
  t.reset(envelopes);
  assert.equal(t.items.length, 2);
  assert.equal(t.lastAppliedSeq, 2);
});

test("exit は警告のシステム行になる", () => {
  const t = fresh();
  t.apply(env({ kind: "exit", code: 1, signal: null }));
  assert.equal(t.items[0]!.kind === "notice" && t.items[0]!.level, "warn");
});

test("permission / question は pending アイテム（PR-M5 まで応答は送らない）", () => {
  const t = fresh();
  t.apply(env({ kind: "permission", id: "p1", toolName: "Bash", input: { command: "rm -rf /" } }));
  t.apply(
    env({ kind: "question", id: "q1", header: "方針", question: "どっち？", options: [{ label: "A" }, { label: "B" }], multi: false }),
  );
  assert.equal(t.items[0]!.kind === "pending" && t.items[0]!.variant, "permission");
  assert.equal(t.items[1]!.kind === "pending" && t.items[1]!.options.length, 2);
});

test("ツール入力の 1 行要約は代表フィールドを拾う", () => {
  assert.equal(summarizeToolInput({ command: "ls  -la\n" }), "ls -la");
  assert.equal(summarizeToolInput({ foo: 1 }), '{"foo":1}');
  assert.equal(summarizeToolInput(null), "");
  assert.equal(oneLine("a".repeat(200)).length, 80);
});

test("状態ラベルは日本語（未知の値はそのまま）", () => {
  assert.equal(stateLabel("busy"), "実行中…");
  assert.equal(stateLabel("waiting"), "応答待ち");
  assert.equal(stateLabel("zzz"), "zzz");
});
