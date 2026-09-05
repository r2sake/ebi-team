// master がチャットへ共有する画像 1 枚を作る（PR-M10）。
//
// 設計書: docs/design/master-chat-inline-image-2026-09-05.md §3（セキュリティ設計）
//
// 経路: master 専用 MCP `chat_image` → POST /control/chat-image → ここ →
//       MasterSession.emitChat({kind:"image"}) → WS `chatEvent` → チャットの画像カード。
//
// 方針（新しい検証ロジックを 1 行も書かない）:
//  - パス検証は **resolveViewerPath() に丸投げ**する（`open_viewer` とまったく同じ関門:
//    絶対パス化 / 拡張子 allow list / realpath でシンボリックリンク脱出防止 /
//    許可ルート（EBI_VIEWER_ROOTS）包含 / 通常ファイル / サイズ上限）。
//    ここで書き足すのは「format が image でなければ拒否」の 1 分岐だけ。
//  - 検証を通ったバイト列は **添付保管庫（ChatAttachmentStore）へコピー**し、以降は
//    basename だけで扱う（配信は既存の `GET /control/chat-attachment?name=` を流用）。
//    元の絶対パスは sourcePath として表示用メタにだけ載せ、配信経路では参照しない。
//  - コピーしておくことで、元ファイルが tmp 掃除で消えてもチャット履歴の画像は残る
//    （viewer のテキストと同じ「スナップショット意味論」）。

import { readFile } from "node:fs/promises";
import type { ChatImage } from "../shared/protocol.ts";
import type { StoredAttachment } from "./chatAttachments.ts";
import { ViewerPathError, imageMimeForPath, resolveViewerPath } from "./viewerRegistry.ts";

/** shareChatImage の依存（テストから temp dir と fake store を差し込めるように外出し）。 */
export interface ShareChatImageDeps {
  /** 許可ルート（ViewerRegistry と同じもの）。 */
  roots: string[];
  /** テキストのサイズ上限（image では使わないが resolveViewerPath の引数として要る）。 */
  maxBytes: number;
  /** 画像のサイズ上限（既定 8MB・EBI_VIEWER_MAX_IMAGE_BYTES）。 */
  maxImageBytes: number;
  /** 保管庫へのコピー（ChatAttachmentStore.save）。 */
  save: (bytes: Buffer, mediaType: string) => Promise<StoredAttachment>;
}

/** 空文字/空白だけの入力を null に潰す（title / caption の正規化）。 */
function trimOrNull(v: string | undefined | null): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

/**
 * 指定パスの画像を検証し、保管庫へコピーして ChatImage を組み立てる。
 *
 * 失敗（許可ルート外・非画像・サイズ超過・不存在）は ViewerPathError を throw する
 * （呼び出し側の制御API が 400 に振り分ける）。
 */
export async function shareChatImage(
  rawPath: string,
  opts: { title?: string | null; caption?: string | null },
  deps: ShareChatImageDeps,
): Promise<ChatImage> {
  const { realPath, absPath, format } = await resolveViewerPath(
    rawPath,
    deps.roots,
    deps.maxBytes,
    deps.maxImageBytes,
  );
  if (format !== "image") {
    throw new ViewerPathError(
      `画像ファイルではありません: ${absPath}（.png/.jpg/.jpeg/.webp/.gif のみチャットへ共有できます）`,
    );
  }
  const mime = imageMimeForPath(realPath);
  // resolveViewerPath が image と判定した以上ここは必ず引けるが、保険で弾く（sniff させない）。
  if (!mime) throw new ViewerPathError(`画像として扱えない拡張子です: ${realPath}`);

  const bytes = await readFile(realPath);
  let stored: StoredAttachment;
  try {
    stored = await deps.save(bytes, mime);
  } catch (err) {
    // 保管庫側の検証（MIME / サイズ）に落ちた場合も 400 相当として扱う。
    throw new ViewerPathError(`保管庫へコピーできませんでした: ${(err as Error).message}`);
  }

  return {
    name: stored.name,
    url: stored.url,
    mediaType: stored.mediaType,
    bytes: stored.bytes,
    sourcePath: absPath,
    title: trimOrNull(opts.title),
    caption: trimOrNull(opts.caption),
  };
}
