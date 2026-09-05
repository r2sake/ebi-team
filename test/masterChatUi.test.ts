// master チャット UI（PR-M3）の表示モデルのテスト。
// DOM には依存しない純関数/純クラス（src/client/chatModel.ts）だけを検証する
// （DOM 側 chat.ts の実画面確認は Playwright スクショ・tmp/shots-m3/）。
//
// 実行: node --import tsx --test test/masterChatUi.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ChatTranscript,
  InputHistory,
  INPUT_HISTORY_KEY,
  LARGE_PASTE_CHARS,
  formatBytes,
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

// ===== PR-M4（入力系）=====

/** localStorage の代わり（unit から挙動を覗くための最小実装）。 */
function memStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    raw: map,
  };
}

test("入力履歴: ↑ で古い方へ、↓ で新しい方へ辿り、末端で編集中テキストに戻る", () => {
  const h = new InputHistory(null);
  h.push("1つ目");
  h.push("2つ目");
  h.push("3つ目");

  assert.equal(h.prev("書きかけ"), "3つ目");
  assert.equal(h.prev("書きかけ"), "2つ目");
  assert.equal(h.prev("書きかけ"), "1つ目");
  // 最古まで来たらそれ以上動かさない（null を返して入力欄を書き換えない）。
  assert.equal(h.prev("書きかけ"), null);

  assert.equal(h.next(), "2つ目");
  assert.equal(h.next(), "3つ目");
  // 末端まで戻ると、辿り始めたときの編集中テキストが復元される。
  assert.equal(h.next(), "書きかけ");
  assert.equal(h.next(), null);
  assert.equal(h.navigating, false);
});

test("入力履歴: 空文字は積まず、同じ本文は重複させない（直近へ寄せる）", () => {
  const h = new InputHistory(null);
  h.push("");
  h.push("   ");
  assert.equal(h.size, 0);
  h.push("A");
  h.push("B");
  h.push("A");
  assert.deepEqual(h.list(), ["B", "A"]);
});

test("入力履歴: 上限（既定 50 件）を超えたら古いものから捨てる", () => {
  const h = new InputHistory(null, INPUT_HISTORY_KEY, 3);
  for (const t of ["a", "b", "c", "d"]) h.push(t);
  assert.deepEqual(h.list(), ["b", "c", "d"]);
});

test("入力履歴: localStorage に永続化され、読み込み直しても残る（再読み込み相当）", () => {
  const store = memStorage();
  const h1 = new InputHistory(store);
  h1.load();
  h1.push("再読み込み後も残る発話");
  assert.equal(store.raw.get(INPUT_HISTORY_KEY), JSON.stringify(["再読み込み後も残る発話"]));

  // ページを開き直した想定で作り直す。
  const h2 = new InputHistory(store);
  h2.load();
  assert.equal(h2.prev(""), "再読み込み後も残る発話");
});

test("入力履歴: 壊れた localStorage の値は捨てる（チャットを壊さない）", () => {
  const h = new InputHistory(memStorage({ [INPUT_HISTORY_KEY]: "{壊れた" }));
  h.load();
  assert.equal(h.size, 0);
  h.push("新規");
  assert.equal(h.size, 1);
});

test("入力履歴: 送信すると辿り位置がリセットされる", () => {
  const h = new InputHistory(null);
  h.push("A");
  h.push("B");
  assert.equal(h.prev(""), "B");
  assert.equal(h.navigating, true);
  h.push("C");
  assert.equal(h.navigating, false);
  assert.equal(h.prev(""), "C");
});

test("user イベントの添付はトランスクリプトに構造化されて載る（無ければ空配列）", () => {
  const t = fresh();
  const attachment = {
    name: "chat-20260905-101112-0a1b2c3d.png",
    path: "/tmp/x/chat-20260905-101112-0a1b2c3d.png",
    mediaType: "image/png",
    url: "/control/chat-attachment?name=chat-20260905-101112-0a1b2c3d.png",
    bytes: 2048,
  };
  t.apply(env({ kind: "user", text: "これ見て", attachments: [attachment] }));
  t.apply(env({ kind: "user", text: "添付なし" }));
  const [first, second] = t.items;
  assert.deepEqual(first!.kind === "user" ? first.attachments : null, [attachment]);
  assert.deepEqual(second!.kind === "user" ? second.attachments : null, []);
});

test("大きな貼り付けの閾値は定数化されている（8,000 文字）", () => {
  assert.equal(LARGE_PASTE_CHARS, 8_000);
});

test("formatBytes: 添付チップのサイズ表示", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
  assert.equal(formatBytes(-1), "—");
});
