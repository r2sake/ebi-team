// master チャット UI（PR-M3）の表示モデルのテスト。
// DOM には依存しない純関数/純クラス（src/client/chatModel.ts）だけを検証する
// （DOM 側 chat.ts の実画面確認は Playwright スクショ・tmp/shots-m3/）。
//
// 実行: node --import tsx --test test/masterChatUi.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ChatTranscript,
  collectImages,
  firstUnsettledPending,
  lightboxCounter,
  LightboxState,
  InputHistory,
  INPUT_HISTORY_KEY,
  LARGE_PASTE_CHARS,
  formatBytes,
  formatContextPct,
  formatCost,
  oneLine,
  replyable,
  replyExcerpt,
  sendEnabled,
  settledLabel,
  stateLabel,
  stopEnabled,
  summarizeToolInput,
} from "../src/client/chatModel.ts";
import type {
  ChatAttachment,
  ChatImage,
  MasterChatEnvelope,
  MasterChatEvent,
} from "../src/shared/protocol.ts";

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

// ===== PR-M11（返信 / 引用）=====

test("返信ボタンを出すのは master 側の発言だけ（自分の発話・ツール・システム行には出さない）", () => {
  const t = fresh();
  t.apply(env({ kind: "text", text: "master の返事", partial: false }));
  t.apply(env({ kind: "user", text: "ボスの発話" }));
  t.apply(env({ kind: "inbound", from: "engineer", tag: "reply", text: "できました" }));
  t.apply(env({ kind: "toolCall", id: "t1", name: "Bash", input: { command: "ls" } }));
  t.apply(env({ kind: "notice", level: "info", text: "お知らせ" }));
  assert.deepEqual(
    t.items.map((it) => [it.kind, replyable(it)]),
    [
      ["assistant", true],
      ["user", false],
      ["inbound", true],
      ["tool", false],
      ["notice", false],
    ],
  );
});

test("引用の抜粋は 1 行に潰して 60 文字で切る", () => {
  const t = fresh();
  t.apply(env({ kind: "text", text: `複数\n行の\n返事 ${"あ".repeat(100)}`, partial: false }));
  const excerpt = replyExcerpt(t.items[0]!);
  assert.equal(excerpt.length, 60);
  assert.ok(excerpt.startsWith("複数 行の 返事 あ"));
  assert.ok(excerpt.endsWith("…"));
});

test("引用の抜粋: エビ返信は送信元つき、共有画像は見出しを使う", () => {
  const t = fresh();
  t.apply(env({ kind: "inbound", from: "engineer", tag: "reply", text: "実装できました" }));
  assert.equal(replyExcerpt(t.items[0]!), "engineer: 実装できました");
  const image: ChatImage = {
    name: "chat-1.png",
    url: "/control/chat-attachment?name=chat-1.png",
    mediaType: "image/png",
    bytes: 10,
    sourcePath: "/tmp/chat-1.png",
    title: "エビの立ち絵",
    caption: "透過版",
  };
  t.apply(env({ kind: "image", images: [image] }));
  assert.equal(replyExcerpt(t.items[1]!), "エビの立ち絵");
  t.apply(env({ kind: "image", images: [{ ...image, title: null, caption: null }] }));
  assert.equal(replyExcerpt(t.items[2]!), "画像 1 枚");
});

test("user イベントの replyTo はトランスクリプトへ載る（無ければ undefined）", () => {
  const t = fresh();
  t.apply(env({ kind: "user", text: "了解", replyTo: { seq: 3, excerpt: "確認をお願いします" } }));
  t.apply(env({ kind: "user", text: "ふつうの発話" }));
  const first = t.items[0]!;
  const second = t.items[1]!;
  assert.deepEqual(first.kind === "user" ? first.replyTo : null, {
    seq: 3,
    excerpt: "確認をお願いします",
  });
  assert.equal(second.kind === "user" ? second.replyTo : "x", undefined);
});

test("引用元は seq で引ける（snapshot 復元後も同じ seq を指す）", () => {
  const target = env({ kind: "text", text: "master の返事", partial: false });
  const envelopes = [
    target,
    env({ kind: "user", text: "了解", replyTo: { seq: target.seq, excerpt: "master の返事" } }),
  ];
  const t = new ChatTranscript();
  t.reset(envelopes);
  const user = t.items.find((it) => it.kind === "user");
  const ref = user?.kind === "user" ? user.replyTo?.seq : null;
  assert.equal(ref, target.seq);
  assert.equal(t.items.findIndex((it) => it.seq === ref), 0);
});

// ===== PR-M11（送信 / 停止の分離）=====

test("busy 中でも送信できる（走行中ターンに合流する・送信が停止に化けない）", () => {
  assert.equal(sendEnabled("busy"), true);
  assert.equal(sendEnabled("idle"), true);
  assert.equal(sendEnabled("waiting"), true);
});

test("頭脳が居ない状態（starting / stopped）では送信も停止もできない", () => {
  for (const state of ["starting", "stopped"]) {
    assert.equal(sendEnabled(state), false, state);
    assert.equal(stopEnabled(state), false, state);
  }
});

test("停止が押せるのはターン実行中（busy）だけ", () => {
  assert.equal(stopEnabled("busy"), true);
  assert.equal(stopEnabled("idle"), false);
  assert.equal(stopEnabled("waiting"), false);
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

// ===== 承認 / 質問（PR-M5）=====

test("permission バブルは未決着で始まり、permissionSettled で畳まれる", () => {
  const t = fresh();
  t.apply(env({ kind: "permission", id: "t1", toolName: "Bash", input: { command: "rm -f x" } }));
  const item = t.items[0]!;
  assert.equal(item.kind, "pending");
  if (item.kind !== "pending") return;
  assert.equal(item.variant, "permission");
  assert.equal(item.settled, null, "未決着＝ UI はボタンを出す");
  assert.match(item.detail, /rm -f x/);

  const change = t.apply(env({ kind: "permissionSettled", id: "t1", outcome: "allowed", answer: "許可" }));
  assert.deepEqual(change.touched, [0], "新しいバブルは積まず既存を更新する");
  assert.equal((t.items[0] as { settled: string }).settled, "allowed");
});

test("question バブルは選択肢と multi を持ち、回答内容が settled に残る", () => {
  const t = fresh();
  t.apply(
    env({
      kind: "question",
      id: "q#0",
      header: "昼食選択",
      question: "寿司とラーメンどちら？",
      options: [
        { label: "寿司", description: "新鮮" },
        { label: "ラーメン" },
      ],
      multi: true,
    }),
  );
  const item = t.items[0]!;
  if (item.kind !== "pending") throw new Error("pending ではない");
  assert.equal(item.title, "昼食選択");
  assert.deepEqual(item.options, ["寿司", "ラーメン"]);
  assert.deepEqual(item.optionNotes, ["新鮮", null]);
  assert.equal(item.multi, true);

  t.apply(env({ kind: "permissionSettled", id: "q#0", outcome: "allowed", answer: "ラーメン" }));
  assert.equal((t.items[0] as { answer: string }).answer, "ラーメン");
});

test("snapshot から復元しても決着済みのバブルにボタンは戻らない", () => {
  const t = fresh();
  const envelopes = [
    env({ kind: "permission", id: "t1", toolName: "Bash", input: null }),
    env({ kind: "permissionSettled", id: "t1", outcome: "discarded", answer: null }),
  ];
  t.reset(envelopes);
  assert.equal(t.items.length, 1);
  assert.equal((t.items[0] as { settled: string }).settled, "discarded");
  assert.equal(firstUnsettledPending(t.items), -1);
});

test("firstUnsettledPending は未応答の先頭を指す（スティッキーバーのジャンプ先）", () => {
  const t = fresh();
  t.apply(env({ kind: "permission", id: "a", toolName: "Bash", input: null }));
  t.apply(env({ kind: "permissionSettled", id: "a", outcome: "allowed", answer: "許可" }));
  t.apply(env({ kind: "text", text: "続きます", partial: false }));
  t.apply(env({ kind: "permission", id: "b", toolName: "Edit", input: null }));
  assert.equal(firstUnsettledPending(t.items), 2);
});

test("対応するバブルが無い permissionSettled は黙って捨てる（ring 溢れ）", () => {
  const t = fresh();
  const change = t.apply(env({ kind: "permissionSettled", id: "zzz", outcome: "allowed", answer: null }));
  assert.deepEqual(change.touched, []);
  assert.equal(t.items.length, 0);
});

test("settledLabel は承認と質問で文面を分ける", () => {
  assert.equal(settledLabel("allowed", "permission", "許可"), "✅ 許可しました");
  assert.match(settledLabel("allowed", "question", "ラーメン"), /ラーメン/);
  assert.equal(settledLabel("denied", "permission", null), "⛔ 拒否しました");
  assert.match(settledLabel("discarded", "question", null), /破棄/);
});

// ===== チャット内画像共有 / ライトボックス（PR-M10）=====

/** master が共有した画像 1 枚（保管庫コピー済みの形）。 */
function img(name: string, over: Partial<ChatImage> = {}): ChatImage {
  return {
    name,
    url: `/control/chat-attachment?name=${name}`,
    mediaType: "image/png",
    bytes: 1234,
    sourcePath: `/home/boss/workspace/tmp/${name}`,
    title: null,
    caption: null,
    ...over,
  };
}

/** ボスが添付した画像 1 枚。 */
function attach(name: string, mediaType = "image/png"): ChatAttachment {
  return {
    name,
    path: `/repo/.ebi-team/chat-attachments/${name}`,
    mediaType,
    url: `/control/chat-attachment?name=${name}`,
    bytes: 999,
  };
}

test("image イベントはアイテムとして積まれ、streaming を閉じる", () => {
  const t = fresh();
  t.apply(env({ kind: "text", text: "作りました", partial: true }));
  const change = t.apply(env({ kind: "image", images: [img("chat-1.png", { title: "エビ" })] }));
  assert.equal(t.items.length, 2);
  assert.equal(change.appendedFrom, 1);
  const streamed = t.items[0]!;
  assert.equal(streamed.kind === "assistant" && streamed.streaming, false, "開いていた streaming は閉じる");
  const item = t.items[1]!;
  assert.equal(item.kind, "image");
  assert.equal(item.kind === "image" ? item.images[0]!.title : null, "エビ");
});

test("snapshot 再適用で image アイテムが復元される（再起動後の履歴）", () => {
  const t = fresh();
  const envelopes = [
    env({ kind: "user", text: "画像ちょうだい" }),
    env({ kind: "image", images: [img("chat-2.png", { caption: "1 枚目" })] }),
  ];
  t.reset(envelopes);
  assert.equal(t.items.length, 2);
  const item = t.items[1]!;
  assert.equal(item.kind === "image" ? item.images[0]!.caption : null, "1 枚目");
});

test("collectImages: ボス添付と master 共有を時系列 1 列にまとめる（テキスト添付は除く）", () => {
  const t = fresh();
  t.apply(env({ kind: "user", text: "これ見て", attachments: [attach("chat-a.png"), attach("chat-note.txt", "text/plain")] }));
  t.apply(env({ kind: "image", images: [img("chat-b.png", { title: "成果" })] }));
  t.apply(env({ kind: "text", text: "以上です", partial: false }));
  t.apply(env({ kind: "image", images: [img("chat-c.png")] }));

  const list = collectImages(t.items);
  assert.deepEqual(
    list.map((e) => e.name),
    ["chat-a.png", "chat-b.png", "chat-c.png"],
    "時系列順・テキスト添付は含まない",
  );
  assert.deepEqual(list.map((e) => e.from), ["boss", "master", "master"]);
  // key は seq とインデックスの組（同じ画像を 2 度出しても衝突しない）。
  assert.equal(new Set(list.map((e) => e.key)).size, 3);
  assert.equal(list[1]!.title, "成果");
});

test("collectImages: 画像が 1 枚も無ければ空配列", () => {
  const t = fresh();
  t.apply(env({ kind: "text", text: "テキストだけ", partial: false }));
  assert.deepEqual(collectImages(t.items), []);
});

test("LightboxState: open / close と現在位置", () => {
  const entries = collectImagesOf(["a", "b", "c"]);
  const lb = new LightboxState(entries);
  assert.equal(lb.isOpen, false);
  assert.equal(lb.current, null);
  assert.equal(lightboxCounter(lb), "");
  assert.equal(lb.open("missing"), false, "未知の key では開かない");
  assert.equal(lb.open(entries[1]!.key), true);
  assert.equal(lb.isOpen, true);
  assert.equal(lb.current?.name, "b");
  assert.equal(lightboxCounter(lb), "2 / 3");
  lb.close();
  assert.equal(lb.isOpen, false);
  assert.equal(lb.current, null);
});

test("LightboxState: next/prev は会話内の全画像を横断し、端では折り返さない", () => {
  const entries = collectImagesOf(["a", "b", "c"]);
  const lb = new LightboxState(entries);
  lb.open(entries[0]!.key);
  assert.equal(lb.hasPrev, false);
  assert.equal(lb.prev(), false, "先頭で prev は何もしない");
  assert.equal(lb.current?.name, "a");
  assert.equal(lb.next(), true);
  assert.equal(lb.current?.name, "b");
  assert.equal(lb.next(), true);
  assert.equal(lb.current?.name, "c");
  assert.equal(lb.hasNext, false);
  assert.equal(lb.next(), false, "末尾で next は何もしない");
  assert.equal(lightboxCounter(lb), "3 / 3");
  assert.equal(lb.prev(), true);
  assert.equal(lb.current?.name, "b");
});

test("LightboxState: 閉じているあいだ next/prev は動かない", () => {
  const entries = collectImagesOf(["a", "b"]);
  const lb = new LightboxState(entries);
  assert.equal(lb.next(), false);
  assert.equal(lb.prev(), false);
  assert.equal(lb.position, 0);
});

test("LightboxState: setEntries は開いている画像に追従し、消えていれば閉じる", () => {
  const entries = collectImagesOf(["a", "b", "c"]);
  const lb = new LightboxState(entries);
  lb.open(entries[1]!.key);
  // 新しい画像が届いた（先頭は同じまま）→ 開いている画像はそのまま、枚数だけ増える。
  const grown = collectImagesOf(["a", "b", "c", "d"]);
  lb.setEntries(grown);
  assert.equal(lb.current?.name, "b");
  assert.equal(lightboxCounter(lb), "2 / 4");
  // トランスクリプトが総入れ替えになって key を見失ったら閉じる。
  lb.setEntries([]);
  assert.equal(lb.isOpen, false);
});

/** name の並びから LightboxEntry 相当（collectImages 経由）を作るヘルパー。 */
function collectImagesOf(names: readonly string[]) {
  const t = fresh();
  for (const n of names) t.apply(env({ kind: "image", images: [img(n)] }));
  return collectImages(t.items);
}
