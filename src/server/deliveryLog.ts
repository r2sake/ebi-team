// 配送イベントの恒久ログ（JSONL 追記）。
//
// 【2026-08-04 配送機構ハードニング】
// 配送のフォールバック警告は `console.warn` だけで出しており、サーバを tty で起動していた場合の
// スクロールバックにしか残らなかった。実際、幽霊購読インシデント（tmp/delivery-investigation-2026-08-04.md）
// の事後調査では「不達 4 件のタイムスタンプ周辺の直接ログが取得できない」という致命的な穴になった。
// そこで配送の異常系（フォールバック・二重購読・注入キュー滞留・未配送破棄）を
// **ファイルへも 1 行 1 JSON で残す**。人間の目視（console）と機械的な追跡（JSONL）を両立させる。
//
// 実体（追記の直列化・ローテート・best-effort 方針）は jsonlLog.ts に切り出してある
// （固定エビの spawn 失敗ログ fixedEbiLog.ts と共通）。

import { JsonlLogger, type JsonlLogEntry } from "./jsonlLog.ts";

/** 1 件の配送ログ。event は機械的な分類キー、msg は人間向けの日本語説明。 */
export type DeliveryLogEntry = JsonlLogEntry;

/** ローテートするサイズ上限（bytes）。超えたら `<path>.1` へ退避して新規に書き直す。 */
const MAX_BYTES = Number(process.env.EBI_DELIVERY_LOG_MAX_BYTES) || 5 * 1024 * 1024;

const logger = new JsonlLogger("delivery", MAX_BYTES);

/**
 * 配送ログの出力先を設定する（サーバ起動時に一度だけ呼ぶ）。
 * null を渡すと以降ファイルへは書かない（console のみ）。
 */
export function configureDeliveryLog(path: string | null): void {
  logger.configure(path);
}

/** 現在の出力先（未設定なら null）。起動ログ表示用。 */
export function deliveryLogPath(): string | null {
  return logger.currentPath();
}

/**
 * 配送イベントを記録する。console（人間向け日本語）とファイル（JSONL）の両方に出す。
 * 呼び出し側は await しない（best-effort・配送のレイテンシに載せない）。
 */
export function logDelivery(entry: DeliveryLogEntry): void {
  logger.log(entry);
}

/** テスト用: 追記チェーンの完了を待つ（本番経路では使わない）。 */
export function flushDeliveryLog(): Promise<void> {
  return logger.flush();
}
