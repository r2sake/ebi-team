// master チャット ヘッダのメトリクス表示（PR-M6）のテスト。
// DOM 非依存の純関数（src/client/chatModel.ts の headerMetrics / metricLevel）だけを検証する
// （実画面は Playwright スクショ・tmp/shots-m6/）。
//
// 実行: node --import tsx --test test/masterChatHeader.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  headerMetrics,
  metricLevel,
  METRIC_THRESHOLDS,
  NO_RATE_LIMITS,
  type ChatStats,
} from "../src/client/chatModel.ts";
import { DEFAULT_CONTEXT_GUARD_CONFIG } from "../src/server/contextGuard.ts";

const stats = (over: Partial<ChatStats> = {}): ChatStats => ({
  model: "opus",
  totalCostUsd: 1.25,
  contextUsedPct: 31.4,
  ...over,
});

test("色分けの閾値は contextGuard（サーバ側）の soft/hard/critical と一致する", () => {
  assert.equal(METRIC_THRESHOLDS.soft, DEFAULT_CONTEXT_GUARD_CONFIG.softPct);
  assert.equal(METRIC_THRESHOLDS.hard, DEFAULT_CONTEXT_GUARD_CONFIG.hardPct);
  assert.equal(METRIC_THRESHOLDS.critical, DEFAULT_CONTEXT_GUARD_CONFIG.criticalPct);
});

test("metricLevel は 65/70/85% の帯で上がる（境界は「以上」）", () => {
  assert.equal(metricLevel(0), "none");
  assert.equal(metricLevel(64.9), "none");
  assert.equal(metricLevel(65), "soft");
  assert.equal(metricLevel(69.9), "soft");
  assert.equal(metricLevel(70), "hard");
  assert.equal(metricLevel(84.9), "hard");
  assert.equal(metricLevel(85), "critical");
  assert.equal(metricLevel(100), "critical");
});

test("算出できない値（null / NaN / Infinity）は none 扱いで色が付かない", () => {
  assert.equal(metricLevel(null), "none");
  assert.equal(metricLevel(Number.NaN), "none");
  assert.equal(metricLevel(Number.POSITIVE_INFINITY), "none");
});

test("ヘッダは コスト / 文脈% / 5h / 週次 の 4 要素をこの順に出す", () => {
  const m = headerMetrics(stats(), { fiveHourPct: 19, sevenDayPct: 4 });
  assert.deepEqual(m.map((x) => x.key), ["cost", "ctx", "fiveHour", "sevenDay"]);
  assert.deepEqual(m.map((x) => x.text), ["$1.25", "ctx 31%", "5h 19%", "週 4%"]);
  assert.deepEqual(m.map((x) => x.level), ["none", "none", "none", "none"]);
});

test("算出不能な backend（codex stub 等）は全部「—」で色も付かない", () => {
  const m = headerMetrics(stats({ model: null, totalCostUsd: null, contextUsedPct: null }), NO_RATE_LIMITS);
  assert.deepEqual(m.map((x) => x.text), ["—", "ctx —", "5h —", "週 —"]);
  assert.ok(m.every((x) => x.level === "none"));
  // model 不明でもツールチップは出す（空にしない）。
  assert.ok(m[0]!.title.includes("model: 不明"));
});

test("70% 超の文脈と 85% 超の枠にそれぞれ hard / critical が付く", () => {
  const m = headerMetrics(stats({ contextUsedPct: 72.4 }), { fiveHourPct: 88, sevenDayPct: 66 });
  assert.equal(m[1]!.text, "ctx 72%");
  assert.equal(m[1]!.level, "hard");
  assert.equal(m[2]!.level, "critical");
  assert.equal(m[3]!.level, "soft");
});

test("枠は片方だけ来ていても、来ていない側だけが「—」になる", () => {
  const m = headerMetrics(stats(), { fiveHourPct: 19, sevenDayPct: null });
  assert.equal(m[2]!.text, "5h 19%");
  assert.equal(m[3]!.text, "週 —");
});

test("ツールチップに model と閾値の説明が入る", () => {
  const m = headerMetrics(stats(), NO_RATE_LIMITS);
  assert.ok(m[0]!.title.includes("model: opus"));
  assert.ok(m[1]!.title.includes("65%") && m[1]!.title.includes("70%") && m[1]!.title.includes("85%"));
});
