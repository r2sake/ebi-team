// 役割プロンプト ACK の「静かな故障」検知＋1 回だけ作り直しの純関数テスト。
//
// 対象:
//   1. 検知正規表現（実測された故障 ACK に当たり、成功 ACK・役割プロンプト・タスク本文には当たらない）
//   2. 作り直しは 1 回だけ（2 回目は fatal・引数を控えていない/エビが消えている遅延イベントは無視）
//   3. fatal 通知の本文（master が「タスクは未実行」と分かる形か）
//   4. 他 backend（claude / gemini）は監視対象外＝挙動不変
//
// 実測の文面は docs/backends/codex.md §7.1（2026-09-05 の 15 ラウンド再測定）が出典。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BACKEND_TRAITS,
  CODEX_ACK_FAILURE_PATTERNS,
  CODEX_ACK_FAILURE_WATCH,
  CODEX_BACKEND,
  matchAckFailure,
} from "../src/server/backends/index.ts";
import {
  buildAckFatalMessage,
  decideAckFailureAction,
  type AckFailureContext,
} from "../src/server/ackRespawn.ts";

/** 実測された「静かな故障」の ACK（docs/backends/codex.md §7.1）。 */
const FAILURE_ACKS = [
  "承知しました。以後、テスト用の疎通係として対応します。\n" +
    "ただし、この環境では reply_to_master ツールが利用できないため、現時点では master へ送信できません。",
  "reply_to_master ツールがこの環境で利用できないため、呼び出せません。",
  "このセッションでは reply_to_master を使用できません。",
  // 2026-09-05 の実装後 e2e（作り直し後のエビ）で観測した変種。初版の正規表現では取りこぼした。
  "この環境には reply_to_master ツールが提供されていないため、master へのツール経由の報告は実行できません。",
  "The reply_to_master tool is not available in this environment.",
  "The ebi-control tools are not provided here.",
];

/** 実測された成功ラウンドの ACK（`利用でき` の語が 1 件も出ない）。 */
const SUCCESS_ACK = "承知しました。テスト用の疎通係として対応します。";

test("検知正規表現: 実測された故障 ACK はすべて検知できる", () => {
  for (const ack of FAILURE_ACKS) {
    const hit = matchAckFailure(ack, CODEX_ACK_FAILURE_PATTERNS);
    assert.notEqual(hit, null, `検知できませんでした: ${ack}`);
    assert.ok(hit!.message.length > 0);
  }
});

test("検知正規表現: 成功 ACK・役割プロンプト・タスク本文には当たらない（エコー誤検知の防止）", () => {
  // 成功ラウンドの ACK。
  assert.equal(matchAckFailure(SUCCESS_ACK, CODEX_ACK_FAILURE_PATTERNS), null);
  // 役割プロンプト（注入時に TUI がそのままエコーする＝走査バッファに必ず入る）。
  const rolePrompt =
    "あなたはエビチームの engineer エビ。master から委譲された単発タスクを実装する『使い捨てセッション』。" +
    "完了したら必ず reply_to_master ツールで、結論ファーストの簡潔な報告を master に送る" +
    "（master はこれを待っている）。破壊的操作・外部送信・git push は勝手にしない。";
  assert.equal(matchAckFailure(rolePrompt, CODEX_ACK_FAILURE_PATTERNS), null);
  // e2e が注入するタスク本文（「届きません」を含むが故障ではない）。
  const taskBody =
    "[e2e-codex] reply_to_master ツールを 1 回だけ呼び、message に PONG1XABCD とだけ入れて" +
    "送ってください（チャットに書くだけでは master に届きません）。";
  assert.equal(matchAckFailure(taskBody, CODEX_ACK_FAILURE_PATTERNS), null);
});

test("検知正規表現: 状態を持たない（同じパターンで何度でも判定できる）", () => {
  // `g` フラグ付き正規表現は lastIndex を持ち、同じ文字列でも 2 回目に false を返す。
  for (const { pattern } of CODEX_ACK_FAILURE_PATTERNS) {
    assert.equal(pattern.global, false, `g フラグは付けないこと: ${pattern}`);
  }
  const ack = FAILURE_ACKS[0]!;
  assert.notEqual(matchAckFailure(ack, CODEX_ACK_FAILURE_PATTERNS), null);
  assert.notEqual(matchAckFailure(ack, CODEX_ACK_FAILURE_PATTERNS), null);
});

test("作り直しは 1 回だけ（1 回目=respawn / 2 回目=fatal）", () => {
  const base: AckFailureContext = { hasParams: true, agentAlive: true, isRetry: false };
  assert.equal(decideAckFailureAction(base), "respawn");
  assert.equal(decideAckFailureAction({ ...base, isRetry: true }), "fatal");
});

test("遅延イベント（引数を控えていない / エビが既に居ない）は何もしない", () => {
  assert.equal(
    decideAckFailureAction({ hasParams: false, agentAlive: true, isRetry: false }),
    "ignore",
  );
  assert.equal(
    decideAckFailureAction({ hasParams: true, agentAlive: false, isRetry: false }),
    "ignore",
  );
  // 2 回目でもエビが消えていれば通知しない（宛先が無い）。
  assert.equal(
    decideAckFailureAction({ hasParams: true, agentAlive: false, isRetry: true }),
    "ignore",
  );
});

test("fatal 通知の本文に「未実行」「別 backend」が入る（master が次の一手を決められる）", () => {
  const text = buildAckFatalMessage("ebi-3", "codex", "エビが『ツールを利用できない』と応答しました");
  assert.match(text, /fatal/);
  assert.match(text, /ebi-3/);
  assert.match(text, /codex/);
  assert.match(text, /未実行/);
  assert.match(text, /claude/);
});

test("監視対象は codex のみ（claude / gemini は未設定＝挙動不変）", () => {
  assert.notEqual(CODEX_BACKEND.ackFailureWatch, null);
  assert.equal(CODEX_BACKEND.ackFailureWatch, CODEX_ACK_FAILURE_WATCH);
  assert.equal(BACKEND_TRAITS.claude.ackFailureWatch ?? null, null);
  assert.equal(BACKEND_TRAITS.gemini.ackFailureWatch ?? null, null);
});

test("監視窓の既定値（ACK 所要 30 秒前後に対して十分な上限・エコーだけで終わらない下限）", () => {
  assert.ok(CODEX_ACK_FAILURE_WATCH.windowMs >= 60000);
  assert.ok(CODEX_ACK_FAILURE_WATCH.minObserveMs >= 1000);
  assert.ok(CODEX_ACK_FAILURE_WATCH.minObserveMs < CODEX_ACK_FAILURE_WATCH.windowMs);
});
