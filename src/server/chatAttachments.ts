// チャット添付ファイルの保管庫（PR-M4）。
//
// 設計書: docs/design/master-chat-ui-2026-09-05.md §9 PR-M4（入力系）
//
// 役割:
//  - 入力欄へのペースト/ドロップで届いた画像を**サーバ側の許可ルート内**へ保存する
//  - 大きな貼り付け（既定 8,000 文字超）をテキストファイルに落とす
//  - 保存済みファイルを **basename でだけ** 引き直す（生パスは一切受け取らない＝
//    新しいパストラバーサル入口を作らない。viewerRegistry の readViewerFile と同じ方針）
//
// 保存先は既定で `<cwd>/.ebi-team/chat-attachments/`（env `EBI_CHAT_ATTACH_DIR` で変更可）。
// master には**絶対パス**を渡す（設計の要件）ので、path は常に resolve 済みのものを返す。

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/** 受け付ける MIME → 拡張子。ここに無い MIME は保存しない（実行可能形式を弾く）。 */
export const ALLOWED_ATTACH_TYPES: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "text/plain": ".txt",
};

/** 1 ファイルの上限（画像 12MB / テキスト 4MB）。 */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;

/** 1 発話に添付できる枚数の上限。 */
export const MAX_ATTACHMENTS_PER_TURN = 4;

/** 保存済みファイル名の形（この形以外は受け取らない）。 */
const NAME_RE = /^chat-[0-9]{8}-[0-9]{6}-[0-9a-f]{8}\.(png|jpg|gif|webp|txt)$/;

export interface StoredAttachment {
  name: string;
  path: string;
  mediaType: string;
  bytes: number;
  url: string;
}

/** ファイル名に使う時刻表現（`20260905-142233`）。ソートしやすく人にも読める。 */
function stamp(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/** 名前が保存庫の形式に合っているか（外から来た文字列の唯一の入口検証）。 */
export function isValidAttachmentName(name: string): boolean {
  // basename() を通すのは `../` や `/` を含む文字列を正規表現の前に潰すため。
  return basename(name) === name && NAME_RE.test(name);
}

/** MIME の上限バイト数。 */
export function maxBytesFor(mediaType: string): number {
  return mediaType === "text/plain" ? MAX_TEXT_BYTES : MAX_IMAGE_BYTES;
}

export class ChatAttachmentStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  /** 保存先ディレクトリ（絶対パス）。 */
  get directory(): string {
    return this.dir;
  }

  /**
   * 1 件保存する。MIME・サイズの検証に落ちたら throw（呼び出し側は 400 にする）。
   * 返り値の path は絶対パス（master に見せる値）。
   */
  async save(
    bytes: Buffer,
    mediaType: string,
    now: Date = new Date(),
  ): Promise<StoredAttachment> {
    const ext = ALLOWED_ATTACH_TYPES[mediaType];
    if (!ext) throw new Error(`対応していない形式です: ${mediaType}`);
    if (bytes.length === 0) throw new Error("空のファイルは添付できません");
    const limit = maxBytesFor(mediaType);
    if (bytes.length > limit) {
      throw new Error(`ファイルが大きすぎます（${bytes.length} > ${limit} バイト）`);
    }
    const name = `chat-${stamp(now)}-${randomBytes(4).toString("hex")}${ext}`;
    const path = join(this.dir, name);
    await mkdir(this.dir, { recursive: true });
    await writeFile(path, bytes);
    return {
      name,
      path,
      mediaType,
      bytes: bytes.length,
      url: `/control/chat-attachment?name=${encodeURIComponent(name)}`,
    };
  }

  /**
   * 保存済みファイルを name で引く（サムネイル配信・stream-json への載せ替えの両方で使う）。
   * name が形式に合わない/実体が無いときは null。
   */
  async read(name: string): Promise<{ bytes: Buffer; mediaType: string; path: string } | null> {
    if (!isValidAttachmentName(name)) return null;
    const path = join(this.dir, name);
    // join 後に保存庫の外へ出ていないことを二重で確認する（name 検証が破られた場合の保険）。
    if (!resolve(path).startsWith(`${this.dir}/`)) return null;
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      return null;
    }
    const ext = Object.entries(ALLOWED_ATTACH_TYPES).find(([, e]) => name.endsWith(e));
    return { bytes, mediaType: ext?.[0] ?? "application/octet-stream", path };
  }
}
