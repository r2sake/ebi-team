// claude ヘッドレス（stream-json）の `rate_limit_event` を UsageStore が食える形へ正規化する純関数。
//
// 背景: PTY master は statusLine JSON の `rate_limits.five_hour.used_percentage`（0〜100）を
// /control/usage へ POST してくるが、chat モードには statusLine が無い。代わりに stream-json が
// `rate_limit_event` を流してくるので、ここを唯一の供給源にする。
//
// **スケールの実測（2026-09-05）**:
//   PoC の生ログ tmp/poc-m0/run1.excerpt.ndjson:
//     {"type":"rate_limit_event","rate_limit_info":{...,"unifiedWindows":{
//        "five_hour":{"utilization":0.13,"resetsAt":1788588600},
//        "seven_day":{"utilization":0.03,"resetsAt":1789030800}}}}
//   同時刻帯の statusLine 実測（.ebi-team/usage-history.jsonl・同じ resetsAt の窓）:
//     five_hour usedPct=15〜18 / seven_day usedPct=4
//   → `utilization` は **0〜1 の割合**（0.13 ≒ 13%）。0〜100 なら 0.13% となり statusLine の
//     15〜18% と 2 桁ずれるため、この解釈以外はありえない。よって **×100 して % にする**。
//   保険として 1 を超える値が来た場合（将来 CLI 側が % 表記に変えた場合）はそのまま % とみなす。

import type { UsageRateLimits } from "../../shared/protocol.ts";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `utilization`（0〜1 の割合）を % へ直す純関数。
 * 1 を超える値は既に % とみなしてそのまま返す（CLI 側の表記変更に対する保険）。
 * 負値・非数は null。
 */
export function utilizationToPct(utilization: unknown): number | null {
  const v = num(utilization);
  if (v == null || v < 0) return null;
  return v > 1 ? v : v * 100;
}

/**
 * `rate_limit_event` を UsageRateLimits の部分更新へ正規化する純関数。
 * 対象外の型・欠測は null（呼び出し側は「更新しない」）。
 */
export function parseRateLimitEvent(raw: unknown): Partial<UsageRateLimits> | null {
  if (!isRecord(raw) || raw.type !== "rate_limit_event") return null;
  const info = isRecord(raw.rate_limit_info) ? raw.rate_limit_info : null;
  const windows = info && isRecord(info.unifiedWindows) ? info.unifiedWindows : null;
  if (!windows) return null;
  const out: Partial<UsageRateLimits> = {};
  const fh = pickWindow(windows.five_hour);
  if (fh) out.fiveHour = fh;
  const sd = pickWindow(windows.seven_day);
  if (sd) out.sevenDay = sd;
  return Object.keys(out).length > 0 ? out : null;
}

function pickWindow(raw: unknown): { usedPct: number; resetsAt: number } | null {
  if (!isRecord(raw)) return null;
  const usedPct = utilizationToPct(raw.utilization);
  const resetsAt = num(raw.resetsAt);
  // resetsAt は統一表現（epoch 秒）。statusLine 側も秒で入れているのでそのまま使う。
  if (usedPct == null || resetsAt == null) return null;
  return { usedPct, resetsAt };
}
