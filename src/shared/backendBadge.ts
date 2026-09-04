// バックエンド（エージェント CLI）の UI 表示メタ（バッジ絵文字・ラベル・usage 報告の可否）。
//
// 設計方針:
// - client（ブラウザ）から読むため **node 組込みに依存しない純粋な定数/関数のみ**にする
//   （src/server/backends/* は node 依存を持ちうるので client からは import しない）。
// - usage（cost / context）を報告するかの真値は server 側の BackendTraits.reportsUsage が SoT。
//   ここはその写しであり、ズレたら test/backendBadge.test.ts が落ちる（同期を機械で担保する）。
// - 「報告しない backend の cost/context を空欄にしない」のが PR-E の要件（設計 §4.5 / Q-8）。
//   空欄は「壊れている」と誤読されるため、必ず UNSUPPORTED_TEXT を出す。

/** backend バッジの表示メタ。 */
export interface BackendBadge {
  /** backend id（未知・未指定は "unknown"）。 */
  id: string;
  /** バッジ絵文字。 */
  emoji: string;
  /** 表示ラベル（title 属性・ダッシュボード列）。 */
  label: string;
  /** statusLine 相当で usage（cost / context）を報告するか。 */
  reportsUsage: boolean;
}

/** 実装済み backend の表示メタ（🟣 claude / 🟢 codex / 🔵 gemini）。 */
export const BACKEND_BADGES: Record<string, BackendBadge> = {
  claude: { id: "claude", emoji: "🟣", label: "claude", reportsUsage: true },
  codex: { id: "codex", emoji: "🟢", label: "codex", reportsUsage: false },
  gemini: { id: "gemini", emoji: "🔵", label: "gemini", reportsUsage: false },
};

/**
 * backend 未指定（サーバ既定で起動した古い registry エントリ等）のフォールバック。
 * 「claude と断定しない」ため専用の表示にする（?＝不明）。usage は表示を欠測扱いにせず
 * 素直に受信値を出す（未指定＝claude 運用の可能性が高く、値が来ていれば正しい）。
 */
export const UNKNOWN_BACKEND_BADGE: BackendBadge = {
  id: "unknown",
  emoji: "⚪",
  label: "backend 不明",
  reportsUsage: true,
};

/** cost / context を報告しない backend に表示する文言（空欄にしない）。 */
export const USAGE_UNSUPPORTED_TEXT = "—（未対応）";

/** usage 未対応セルの title（なぜ「—」なのかを説明する）。 */
export const USAGE_UNSUPPORTED_TITLE =
  "この backend は statusLine 相当の usage 報告に未対応（cost / context は取得できない）";

/** backend id から表示メタを引く。未知/未指定は UNKNOWN_BACKEND_BADGE。 */
export function backendBadge(backend: string | null | undefined): BackendBadge {
  if (!backend) return UNKNOWN_BACKEND_BADGE;
  return BACKEND_BADGES[backend] ?? UNKNOWN_BACKEND_BADGE;
}

/** その backend が cost / context を報告するか（未知/未指定は true＝受信値をそのまま出す）。 */
export function backendReportsUsage(backend: string | null | undefined): boolean {
  return backendBadge(backend).reportsUsage;
}

/**
 * usage 値の表示文字列を作る。
 * - 報告しない backend: 常に「—（未対応）」（値が無いことを明示する）。
 * - 報告する backend: 値があれば format(value)、無ければ "-"（＝データ待ち）。
 */
export function formatUsageCell<T>(
  backend: string | null | undefined,
  value: T | null | undefined,
  format: (v: T) => string,
): string {
  if (!backendReportsUsage(backend)) return USAGE_UNSUPPORTED_TEXT;
  return value === null || value === undefined ? "-" : format(value);
}
