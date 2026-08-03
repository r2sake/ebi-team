// 配送イベントの恒久ログ（JSONL 追記）。
//
// 【2026-08-04 配送機構ハードニング】
// 配送のフォールバック警告は `console.warn` だけで出しており、サーバを tty で起動していた場合の
// スクロールバックにしか残らなかった。実際、幽霊購読インシデント（tmp/delivery-investigation-2026-08-04.md）
// の事後調査では「不達 4 件のタイムスタンプ周辺の直接ログが取得できない」という致命的な穴になった。
// そこで配送の異常系（フォールバック・二重購読・注入キュー滞留・未配送破棄）を
// **ファイルへも 1 行 1 JSON で残す**。人間の目視（console）と機械的な追跡（JSONL）を両立させる。
//
// 方針:
// - best-effort。書き込み失敗で配送を止めない（ログのために本業を壊さない）。
// - 追記は直列化して行の混線を防ぐ（append の並行実行順序に依存しない）。
// - サイズ上限を超えたら 1 世代だけローテートする（無限肥大の防止。長期保存は要件外）。
// - configure されるまでファイルへは書かない（ユニットテストが勝手にファイルを作らないため）。

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** 1 件の配送ログ。event は機械的な分類キー、msg は人間向けの日本語説明。 */
export interface DeliveryLogEntry {
  /** 分類キー（例: "pty-fallback" / "duplicate-subscriber"）。grep/集計の軸にする。 */
  event: string;
  /** 人間向けの説明（console にもこの文言を出す）。 */
  msg: string;
  /** 深刻度。warn は console.warn、info は console.log。 */
  level?: "warn" | "info";
  /** 任意の構造化フィールド（id / from / via など）。 */
  [key: string]: unknown;
}

/** ローテートするサイズ上限（bytes）。超えたら `<path>.1` へ退避して新規に書き直す。 */
const MAX_BYTES = Number(process.env.EBI_DELIVERY_LOG_MAX_BYTES) || 5 * 1024 * 1024;

let logPath: string | null = null;
let writtenBytes = 0;
/** 追記の直列化チェーン（行の混線防止）。 */
let chain: Promise<void> = Promise.resolve();

/**
 * 配送ログの出力先を設定する（サーバ起動時に一度だけ呼ぶ）。
 * null を渡すと以降ファイルへは書かない（console のみ）。
 */
export function configureDeliveryLog(path: string | null): void {
  logPath = path;
  writtenBytes = 0;
  if (!path) return;
  // 既存ファイルのサイズを引き継いでローテート判定に使う（起動のたびに 0 に戻さない）。
  chain = chain
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const st = await stat(path).catch(() => null);
      writtenBytes = st?.size ?? 0;
    })
    .catch(() => {});
}

/** 現在の出力先（未設定なら null）。起動ログ表示用。 */
export function deliveryLogPath(): string | null {
  return logPath;
}

/**
 * 配送イベントを記録する。console（人間向け日本語）とファイル（JSONL）の両方に出す。
 * 呼び出し側は await しない（best-effort・配送のレイテンシに載せない）。
 */
export function logDelivery(entry: DeliveryLogEntry): void {
  const { event, msg, level = "warn", ...fields } = entry;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, msg, ...fields });
  if (level === "warn") console.warn(`[delivery:${event}] ${msg}`);
  else console.log(`[delivery:${event}] ${msg}`);
  const path = logPath;
  if (!path) return;
  chain = chain
    .then(async () => {
      const buf = `${line}\n`;
      if (writtenBytes + buf.length > MAX_BYTES) {
        await rename(path, `${path}.1`).catch(() => {});
        writtenBytes = 0;
      }
      await appendFile(path, buf, "utf8");
      writtenBytes += buf.length;
    })
    .catch((err) => {
      // ログの失敗でチェーンを壊さない（以降の書き込みは続行する）。
      console.warn("[delivery] 配送ログの書き込みに失敗:", (err as Error).message);
    });
}

/** テスト用: 追記チェーンの完了を待つ（本番経路では使わない）。 */
export function flushDeliveryLog(): Promise<void> {
  return chain;
}
