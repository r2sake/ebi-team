// 起動ゲート自動応答まわりの純関数ユニットテスト（実 claude 起動なし・別ポート e2e とは独立）。
//   - isDevChannelsAutoAnswerEligible: 正確値の許可リスト判定（該当/非該当/複数指定/ワイルドカード拒否）
//   - detectStartupGate: 空白なし照合（TUI が空白を潰して描画する罠への対応）
//   - isNotifySubscribeEnabled: 購読無効分岐
//
// 実行: node --import tsx --test test/gate.test.ts
// 注意: 環境変数 EBI_ID 等の混入を避けるため `env -u EBI_ID` で回すこと。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isDevChannelsAutoAnswerEligible,
  detectStartupGate,
  containsEcho,
  echoNeedle,
  BASE_ALLOWED_DEV_CHANNELS,
} from "../src/server/agent.ts";
import { isNotifySubscribeEnabled } from "../src/mcp/control-server.ts";
import { deliveryTag } from "../src/shared/deliveryTag.ts";

const FLAG = "--dangerously-load-development-channels";

test("組込み許可リスト: server:ebi-control ちょうど1個 → 該当", () => {
  assert.equal(isDevChannelsAutoAnswerEligible([FLAG, "server:ebi-control"]), true);
});

test("組込み許可リスト: 未知のサーバ名 → 非該当", () => {
  assert.equal(isDevChannelsAutoAnswerEligible([FLAG, "server:other"]), false);
});

test("フラグ自体が無い → 非該当", () => {
  assert.equal(isDevChannelsAutoAnswerEligible(["--model", "opus"]), false);
});

test("フラグはあるが値が無い（次フラグまでで空） → 非該当", () => {
  assert.equal(isDevChannelsAutoAnswerEligible([FLAG, "--effort", "medium"]), false);
});

test("許可リスト拡張: plugin:slack@minaebi-local を足せば該当（minaebi 起動形態）", () => {
  const allow = [...BASE_ALLOWED_DEV_CHANNELS, "plugin:slack@minaebi-local"];
  assert.equal(
    isDevChannelsAutoAnswerEligible([FLAG, "plugin:slack@minaebi-local"], allow),
    true,
  );
  // 許可リストに入れていなければ（組込みのみ）非該当のまま。
  assert.equal(isDevChannelsAutoAnswerEligible([FLAG, "plugin:slack@minaebi-local"]), false);
});

test("複数指定: すべて許可リストに正確一致 → 該当", () => {
  const allow = ["server:ebi-control", "plugin:slack@minaebi-local"];
  assert.equal(
    isDevChannelsAutoAnswerEligible([FLAG, "server:ebi-control", "plugin:slack@minaebi-local"], allow),
    true,
  );
});

test("複数指定: 1つでも許可リスト外が混ざる → 非該当", () => {
  const allow = ["server:ebi-control", "plugin:slack@minaebi-local"];
  assert.equal(
    isDevChannelsAutoAnswerEligible([FLAG, "server:ebi-control", "server:evil"], allow),
    false,
  );
});

test("ワイルドカード拒否: '*' 付き値は完全一致しない限り非該当", () => {
  const allow = ["server:ebi-control", "plugin:slack@minaebi-local"];
  assert.equal(isDevChannelsAutoAnswerEligible([FLAG, "plugin:slack@*"], allow), false);
  assert.equal(isDevChannelsAutoAnswerEligible([FLAG, "server:ebi-control*"], allow), false);
});

test("部分一致拒否: 許可値の前方部分文字列でも非該当", () => {
  const allow = ["server:ebi-control"];
  assert.equal(isDevChannelsAutoAnswerEligible([FLAG, "server:ebi"], allow), false);
});

test("次フラグで値の取り込みが止まる（後続の別フラグを値に含めない）", () => {
  // FLAG server:ebi-control --effort medium → 値は [server:ebi-control] だけ → 該当。
  assert.equal(
    isDevChannelsAutoAnswerEligible([FLAG, "server:ebi-control", "--effort", "medium"]),
    true,
  );
});

// ---- detectStartupGate: 空白なし照合 ----

test("空白あり描画: 'I am using this for local development' → devChannels", () => {
  assert.equal(detectStartupGate("WARNING: I am using this for local development"), "devChannels");
});

test("空白なし描画（TUI の罠）: 'Iamusingthisforlocaldevelopment' → devChannels", () => {
  assert.equal(detectStartupGate("Iamusingthisforlocaldevelopment"), "devChannels");
});

test("'Loading development channels' → devChannels", () => {
  assert.equal(detectStartupGate("Loading development channels\n1. I am using..."), "devChannels");
});

test("workspace trust（空白あり）: 'Is this a project you trust' → trust", () => {
  assert.equal(detectStartupGate("Is this a project you trust?"), "trust");
});

test("workspace trust（空白なし）: 'trustthisfolder' → trust", () => {
  assert.equal(detectStartupGate("Do you trust this folder"), "trust");
});

test("無関係な出力 → null", () => {
  assert.equal(detectStartupGate("Welcome to Claude Code. Ready."), null);
});

// ---- isNotifySubscribeEnabled: 購読無効分岐 ----

test("購読: 未設定 → 有効（既定 on）", () => {
  assert.equal(isNotifySubscribeEnabled(undefined), true);
});

test("購読: 'on' → 有効", () => {
  assert.equal(isNotifySubscribeEnabled("on"), true);
});

test("購読: 'off'/'0'/'false'/'OFF' → 無効", () => {
  assert.equal(isNotifySubscribeEnabled("off"), false);
  assert.equal(isNotifySubscribeEnabled("0"), false);
  assert.equal(isNotifySubscribeEnabled("false"), false);
  assert.equal(isNotifySubscribeEnabled("OFF"), false);
});

test("購読: '1' や他の文字列 → 有効", () => {
  assert.equal(isNotifySubscribeEnabled("1"), true);
  assert.equal(isNotifySubscribeEnabled("yes"), true);
});

// ---- containsEcho / echoNeedle: channel 配送のセッション到達照合（spawn 直後の消失根治）----
// claude TUI は channel 受信を `ebi-control: [from:master#90] <本文先頭>…` と、空白を潰し
// 先頭を切り詰めて描画する。この描画を「セッションに実際に届いた」唯一の観測点として使うため、
// compact 同士で照合する。針は **msgId 入りの行頭タグ**（本文ではない）＝ 2026-08-16 の変更。

test("containsEcho: TUI が空白を潰して先頭だけ描画してもタグで到達と判定する", () => {
  const tag = deliveryTag("master", 90);
  const rendered =
    "\x1b[2m❯ ←\x1b[0mebi-control:[from:master#90]#タスク2（到達計測用・トークンACKOK2XEAYS…";
  assert.equal(containsEcho(rendered, tag), true);
});

test("containsEcho: 空白ありで描画された場合も到達と判定する", () => {
  const tag = deliveryTag("master", 7);
  assert.equal(
    containsEcho("ebi-control: [from:master#7] hello world from ebi-team…", tag),
    true,
  );
});

test("containsEcho: 本文が和文で切り詰められてもタグは行頭なので到達と判定できる（回帰）", () => {
  // 【2026-08-16 実障害】本文先頭を針にしていた旧実装は、TUI の切り詰めが表示カラム基準
  // （80 桁端末で約 56 桁）・針が文字数基準（24）だったため、1 文字 2 カラムの和文では
  // 針が原理的に描画長を超えて 100% 不一致になっていた。タグ照合ならこの影響を受けない。
  const tag = deliveryTag("master", 90);
  const rendered =
    "ebi-control:[from:master#90]【ボス目視フィードバック・修正】スキル倉庫の…";
  assert.equal(containsEcho(rendered, tag), true);
});

test("containsEcho: 別の msgId の描画を到達と誤認しない（#9 は #90 に一致しない）", () => {
  const rendered = "ebi-control:[from:master#9]別のメッセージ…";
  assert.equal(containsEcho(rendered, deliveryTag("master", 90)), false, "前方一致で誤検知しない");
  assert.equal(containsEcho(rendered, deliveryTag("master", 9)), true, "本人のタグには一致する");
});

test("containsEcho: channel が捨てられ何も描画されない scrollback は未到達と判定する", () => {
  // 実際の失敗ラウンドの scrollback（harness が channel を honor できなかったときの表示）。
  const rendered =
    "▎server:ebi-control · no MCP server configured with that name" +
    "❯ Try \"refactor <filepath>\"⏵⏵ bypass permissions on";
  assert.equal(containsEcho(rendered, deliveryTag("master", 1)), false);
});

test("containsEcho: タグが空/空白のみなら誤検知させない（常に false）", () => {
  assert.equal(containsEcho("なんでも描画されている", "   \n  "), false);
});

test("echoNeedle: タグを compact したものを針にする（空白・ANSI を落とす）", () => {
  assert.equal(echoNeedle(deliveryTag("master", 90)), "[from:master#90]");
  // msgId 無し（PTY 専用経路）は従来書式のまま針になる。
  assert.equal(echoNeedle(deliveryTag("master")), "[from:master]");
  assert.equal(echoNeedle("\x1b[2m[from:ebi-1#3] \x1b[0m"), "[from:ebi-1#3]");
});
