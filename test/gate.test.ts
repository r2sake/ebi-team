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
  BASE_ALLOWED_DEV_CHANNELS,
} from "../src/server/agent.ts";
import { isNotifySubscribeEnabled } from "../src/mcp/control-server.ts";

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
