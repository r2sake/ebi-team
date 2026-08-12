// 固定エビ（master/supervisor 等）のライフサイクル異常の恒久ログ（JSONL 追記）。
//
// 【2026-08-12 master 起動不能インシデント】
// master の --mcp-config が実在しないパスを指しており、claude が起動直後にエラー終了 →
// 1s/2s/4s/8s のバックオフで 5 連続失敗 → 約 15 秒で crashloop 停止、という事象が起きた。
// このとき手がかりは (a) 即死した PTY（exit で registry から消えるためタイルごと消滅）と
// (b) broadcast だけの notice（ブラウザを開く頃には流れ終わっている）と (c) サーバ stdout のみで、
// 「エラーが何も出ていない」ように見えた。delivery.log は配送イベント専用で spawn 失敗は載らない。
//
// そこで固定エビの spawn 失敗・再起動予約・crashloop 停止を専用ファイルへ残し、事後に必ず
// 追跡できるようにする。実体（追記の直列化・ローテート・best-effort 方針）は jsonlLog.ts と共通。

import { JsonlLogger, type JsonlLogEntry } from "./jsonlLog.ts";

/** 1 件の固定エビログ。event は機械的な分類キー、msg は人間向けの日本語説明。 */
export type FixedEbiLogEntry = JsonlLogEntry;

/** ローテートするサイズ上限（bytes）。配送ログより低頻度なので小さめで足りる。 */
const MAX_BYTES = Number(process.env.EBI_FIXED_EBI_LOG_MAX_BYTES) || 1024 * 1024;

const logger = new JsonlLogger("fixed-ebi", MAX_BYTES);

/**
 * 固定エビログの出力先を設定する（サーバ起動時に一度だけ呼ぶ）。
 * null を渡すと以降ファイルへは書かない（console のみ）。
 */
export function configureFixedEbiLog(path: string | null): void {
  logger.configure(path);
}

/** 現在の出力先（未設定なら null）。起動ログ表示用。 */
export function fixedEbiLogPath(): string | null {
  return logger.currentPath();
}

/**
 * 固定エビのライフサイクルイベントを記録する。
 * 呼び出し側は await しない（best-effort・起動フローのレイテンシに載せない）。
 */
export function logFixedEbi(entry: FixedEbiLogEntry): void {
  logger.log(entry);
}

/** テスト用: 追記チェーンの完了を待つ（本番経路では使わない）。 */
export function flushFixedEbiLog(): Promise<void> {
  return logger.flush();
}
