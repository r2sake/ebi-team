// PR-E（UI: backend バッジ / usage 欠測の「—（未対応）」表示）の純関数テスト。
//
// 対象:
//   1. shared の表示メタ（backendBadge）と server の SoT（BACKEND_TRAITS.reportsUsage）の同期
//   2. usage セルの文言（非対応 backend は必ず「—（未対応）」・空欄にしない）
//   3. ダッシュボード行の合成（mergeUsageRows: usage が来ないエビも欠測行として出す）

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BACKEND_BADGES,
  USAGE_UNSUPPORTED_TEXT,
  backendBadge,
  backendReportsUsage,
  formatUsageCell,
} from "../src/shared/backendBadge.ts";
import { ALL_BACKEND_IDS, BACKEND_TRAITS } from "../src/server/backends/index.ts";
import { mergeUsageRows } from "../src/client/dashboard.ts";
import type { AgentRecord, UsageAgent } from "../src/shared/protocol.ts";

// ===== 1. SoT との同期 =====

test("全 backend にバッジ定義があり、reportsUsage が server の SoT と一致する", () => {
  for (const id of ALL_BACKEND_IDS) {
    const badge = BACKEND_BADGES[id];
    assert.ok(badge, `${id} のバッジ定義が無い`);
    assert.equal(badge.id, id);
    assert.ok(badge.emoji.length > 0);
    assert.equal(
      badge.reportsUsage,
      BACKEND_TRAITS[id].reportsUsage,
      `${id} の reportsUsage が BACKEND_TRAITS とズレている`,
    );
  }
  // 設計 §4.5: claude だけが usage を報告する（codex / gemini は欠測）。
  assert.equal(backendReportsUsage("claude"), true);
  assert.equal(backendReportsUsage("codex"), false);
  assert.equal(backendReportsUsage("gemini"), false);
});

test("未知/未指定 backend はフォールバック表示（claude と断定しない）", () => {
  assert.equal(backendBadge(undefined).id, "unknown");
  assert.equal(backendBadge(null).id, "unknown");
  assert.equal(backendBadge("gpt4all").id, "unknown");
  // 未指定は usage 受信値をそのまま出す（欠測扱いにしない）。
  assert.equal(backendReportsUsage(undefined), true);
});

// ===== 2. usage セルの文言 =====

test("usage 非対応 backend のセルは値の有無に関わらず「—（未対応）」", () => {
  assert.equal(formatUsageCell("codex", null, String), USAGE_UNSUPPORTED_TEXT);
  assert.equal(formatUsageCell("gemini", 42, String), USAGE_UNSUPPORTED_TEXT);
  // 空欄・"-" にはしない（「壊れている」と誤読されるため）。
  assert.notEqual(USAGE_UNSUPPORTED_TEXT, "");
  assert.notEqual(USAGE_UNSUPPORTED_TEXT, "-");
});

test("usage 対応 backend は従来どおり（値ありは整形・未受信は '-'）", () => {
  assert.equal(formatUsageCell("claude", 12, (v) => `${v}%`), "12%");
  assert.equal(formatUsageCell("claude", null, (v) => `${v}%`), "-");
  assert.equal(formatUsageCell(undefined, 3.5, (v) => `$${v.toFixed(2)}`), "$3.50");
});

// ===== 3. ダッシュボード行の合成 =====

/** テスト用 usage レコード。 */
function usage(id: string, costUsd: number): UsageAgent {
  return {
    id,
    model: "claude-opus-5",
    costUsd,
    contextUsedPct: 10,
    contextSize: 200000,
    tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
    updatedAt: 0,
  };
}

/** テスト用 registry レコード（表示に要るフィールドのみ）。 */
function agent(id: string, backend?: string): AgentRecord {
  return {
    id,
    kind: "dynamic",
    status: "idle",
    mode: "connected",
    cwd: "/tmp",
    pid: 1,
    pinned: false,
    model: null,
    backend,
  } as AgentRecord;
}

test("usage を報告しない backend のエビは registry から欠測行を起こす", () => {
  const rows = mergeUsageRows([usage("ebi-1", 1)], [agent("ebi-1", "claude"), agent("ebi-2", "codex")]);
  assert.deepEqual(
    rows.map((r) => [r.id, r.backend, r.usage === null]),
    [
      ["ebi-1", "claude", false],
      ["ebi-2", "codex", true],
    ],
  );
});

test("usage 対応 backend で未受信のエビは行を起こさない（従来どおりデータ待ち）", () => {
  const rows = mergeUsageRows([], [agent("ebi-1", "claude"), agent("ebi-2")]);
  assert.equal(rows.length, 0);
});

test("registry に居ない usage（kill 済み等）も行として残す（backend は unknown 表示）", () => {
  const rows = mergeUsageRows([usage("gone", 2)], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].backend, undefined);
  assert.equal(backendBadge(rows[0].backend).id, "unknown");
});
