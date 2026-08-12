// JSONL 追記ロガーの共通実装（配送ログ・固定エビログの土台）。
//
// 元は deliveryLog.ts に直書きしていたものを、同じ性質のログ（人間向け console ＋
// 機械追跡用 JSONL）を別系統でも持てるように切り出した。挙動は deliveryLog 時代と同一。
//
// 方針:
// - best-effort。書き込み失敗で本業を止めない（ログのために配送や spawn を壊さない）。
// - 追記は直列化して行の混線を防ぐ（append の並行実行順序に依存しない）。
// - サイズ上限を超えたら 1 世代だけローテートする（無限肥大の防止。長期保存は要件外）。
// - configure されるまでファイルへは書かない（ユニットテストが勝手にファイルを作らないため）。

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** 1 件のログ。event は機械的な分類キー、msg は人間向けの日本語説明。 */
export interface JsonlLogEntry {
  /** 分類キー（例: "pty-fallback" / "spawn-failed"）。grep/集計の軸にする。 */
  event: string;
  /** 人間向けの説明（console にもこの文言を出す）。 */
  msg: string;
  /** 深刻度。warn は console.warn、info は console.log。 */
  level?: "warn" | "info";
  /** 任意の構造化フィールド（id / from / via など）。 */
  [key: string]: unknown;
}

/** JSONL 追記ロガー。1 インスタンス = 1 ファイル（＋ console 出力プレフィクス）。 */
export class JsonlLogger {
  private path: string | null = null;
  private writtenBytes = 0;
  /** 追記の直列化チェーン（行の混線防止）。 */
  private chain: Promise<void> = Promise.resolve();

  /**
   * @param consolePrefix console 出力のプレフィクス（`[<prefix>:<event>] msg` の形になる）。
   * @param maxBytes ローテートするサイズ上限（bytes）。超えたら `<path>.1` へ退避する。
   */
  constructor(
    private readonly consolePrefix: string,
    private readonly maxBytes: number,
  ) {}

  /**
   * 出力先を設定する（サーバ起動時に一度だけ呼ぶ）。
   * null を渡すと以降ファイルへは書かない（console のみ）。
   */
  configure(path: string | null): void {
    this.path = path;
    this.writtenBytes = 0;
    if (!path) return;
    // 既存ファイルのサイズを引き継いでローテート判定に使う（起動のたびに 0 に戻さない）。
    this.chain = this.chain
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        const st = await stat(path).catch(() => null);
        this.writtenBytes = st?.size ?? 0;
      })
      .catch(() => {});
  }

  /** 現在の出力先（未設定なら null）。起動ログ表示用。 */
  currentPath(): string | null {
    return this.path;
  }

  /**
   * イベントを記録する。console（人間向け日本語）とファイル（JSONL）の両方に出す。
   * 呼び出し側は await しない（best-effort・本業のレイテンシに載せない）。
   */
  log(entry: JsonlLogEntry): void {
    const { event, msg, level = "warn", ...fields } = entry;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, msg, ...fields });
    if (level === "warn") console.warn(`[${this.consolePrefix}:${event}] ${msg}`);
    else console.log(`[${this.consolePrefix}:${event}] ${msg}`);
    const path = this.path;
    if (!path) return;
    this.chain = this.chain
      .then(async () => {
        const buf = `${line}\n`;
        if (this.writtenBytes + buf.length > this.maxBytes) {
          await rename(path, `${path}.1`).catch(() => {});
          this.writtenBytes = 0;
        }
        await appendFile(path, buf, "utf8");
        this.writtenBytes += buf.length;
      })
      .catch((err) => {
        // ログの失敗でチェーンを壊さない（以降の書き込みは続行する）。
        console.warn(`[${this.consolePrefix}] ログの書き込みに失敗:`, (err as Error).message);
      });
  }

  /** テスト用: 追記チェーンの完了を待つ（本番経路では使わない）。 */
  flush(): Promise<void> {
    return this.chain;
  }
}
