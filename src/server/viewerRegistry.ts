// viewer（読み取り専用の md/txt プレビュー）を保持するコレクション。
//
// 設計方針:
// - AgentRecord（PTY プロセス前提）を汚さず、viewer は「プロセスを持たない UI エンティティ」
//   として別コレクションで持つ。1 件 = { id, path, title, format, content }。
// - 起動口は master 専用 MCP `open_viewer` → POST /control/open-viewer → open()。
//   閉じるのは WS `{type:"closeViewer"}` → close()。いずれも変更後に viewers を再 broadcast する。
// - パス安全（外部参照の制限・読み取り専用）:
//   - EBI_VIEWER_ROOTS（`:` 区切り・未設定時は `$HOME/workspace`）配下に限定。
//   - realpath でシンボリックリンク脱出を防止（実体が許可ルート配下にあること）。
//   - 拡張子は .md / .markdown / .txt に限定、サイズ上限あり、書き込み口は作らない。

import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve, extname, basename, sep } from "node:path";
import type { ViewerRecord, ViewerFormat } from "../shared/protocol.ts";

/** viewer に許可する拡張子とレンダリング形式の対応。 */
const ALLOWED_EXT: Record<string, ViewerFormat> = {
  ".md": "md",
  ".markdown": "md",
  ".txt": "txt",
};

/** ファイルサイズ上限の既定（バイト）。env EBI_VIEWER_MAX_BYTES で上書き可。 */
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1MB

/** `~` / `$HOME` / `${HOME}` を展開する（未知変数はそのまま）。 */
function expandHome(input: string): string {
  let s = input;
  if (s === "~" || s.startsWith("~/")) s = homedir() + s.slice(1);
  s = s.replace(/\$\{?HOME\}?/g, homedir());
  return s;
}

/**
 * 許可ルート集合を決める。
 * - env EBI_VIEWER_ROOTS があれば `:` 区切りで解釈（`~`/`$HOME` 展開）。
 * - 無ければ既定 `$HOME/workspace`。
 * ここでは正規化のみ行い、実体（realpath）解決は検証時に行う（起動時に存在しなくてもよい）。
 */
export function defaultViewerRoots(): string[] {
  const raw = process.env.EBI_VIEWER_ROOTS;
  const list = raw
    ? raw.split(":").map((s) => s.trim()).filter(Boolean)
    : [resolve(homedir(), "workspace")];
  return list.map((p) => resolve(expandHome(p)));
}

/** open 済み viewer の内部形（content 込み）。 */
type ViewerEntry = ViewerRecord;

export interface ViewerRegistryOptions {
  /** 許可ルート（未指定は defaultViewerRoots()）。テストで temp dir を渡すのに使う。 */
  roots?: string[];
  /** サイズ上限（バイト・未指定は env or 既定 1MB）。 */
  maxBytes?: number;
}

/**
 * 検証エラー。制御API 側で 400 に振り分けるため識別可能にしておく。
 */
export class ViewerPathError extends Error {}

/**
 * viewer 用にパスを検証し、実パス・形式・サイズを確定して返す。
 * DOM/ファイル読み込みの前段（純粋にパス安全性のみ）を独立させ、単体テストしやすくする。
 * 失敗時は ViewerPathError を throw する。
 */
export async function resolveViewerPath(
  rawPath: string,
  roots: string[],
  maxBytes: number,
): Promise<{ absPath: string; realPath: string; format: ViewerFormat; size: number }> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new ViewerPathError("path（文字列）は必須です");
  }
  const expanded = expandHome(rawPath.trim());
  // 相対パスは許可ルートの実体解決だけでは基準が曖昧なので、絶対パスを要求する。
  const absPath = isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);

  // 拡張子チェック（realpath 前に安価に弾く）。
  const ext = extname(absPath).toLowerCase();
  const format = ALLOWED_EXT[ext];
  if (!format) {
    throw new ViewerPathError(
      `対応していない拡張子です: ${ext || "(なし)"}（許容: ${Object.keys(ALLOWED_EXT).join(", ")}）`,
    );
  }

  // 実体（realpath）を解決してシンボリックリンク脱出を防ぐ。存在しなければ弾く。
  let realPath: string;
  try {
    realPath = await realpath(absPath);
  } catch {
    throw new ViewerPathError(`ファイルが存在しません: ${absPath}`);
  }

  // 許可ルート配下か（各ルートの realpath 基準で包含判定）。
  let allowed = false;
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue; // 存在しないルートはスキップ。
    }
    if (realPath === realRoot || realPath.startsWith(realRoot + sep)) {
      allowed = true;
      break;
    }
  }
  if (!allowed) {
    throw new ViewerPathError(
      `許可ルート外のパスです: ${realPath}（許可ルート: ${roots.join(", ") || "(なし)"}。EBI_VIEWER_ROOTS で設定）`,
    );
  }

  // 通常ファイル & サイズ上限。
  const st = await stat(realPath);
  if (!st.isFile()) {
    throw new ViewerPathError(`通常ファイルではありません: ${realPath}`);
  }
  if (st.size > maxBytes) {
    throw new ViewerPathError(`ファイルが大きすぎます: ${st.size} バイト（上限 ${maxBytes} バイト）`);
  }

  return { absPath, realPath, format, size: st.size };
}

/**
 * viewer コレクション。open/close と現在一覧の取得を提供する。
 * 変更通知（broadcast）はコンストラクタで受け取る onChange に委ねる（index.ts が配線）。
 */
export class ViewerRegistry {
  private readonly viewers = new Map<string, ViewerEntry>();
  private seq = 0;
  private readonly roots: string[];
  private readonly maxBytes: number;

  constructor(opts: ViewerRegistryOptions = {}) {
    this.roots = opts.roots ?? defaultViewerRoots();
    this.maxBytes =
      opts.maxBytes ?? (Number(process.env.EBI_VIEWER_MAX_BYTES) || DEFAULT_MAX_BYTES);
  }

  /** 現在の許可ルート（表示・ログ用）。 */
  getRoots(): string[] {
    return [...this.roots];
  }

  /**
   * ファイルを開いて viewer を 1 件登録する。パス検証に失敗したら ViewerPathError を throw。
   * content は open 時点のスナップショット（読み取り専用）。
   */
  async open(params: { path: string; title?: string }): Promise<ViewerRecord> {
    const { realPath, absPath, format } = await resolveViewerPath(
      params.path,
      this.roots,
      this.maxBytes,
    );
    const content = await readFile(realPath, "utf8");
    const id = `viewer-${++this.seq}`;
    const title =
      params.title && params.title.trim() ? params.title.trim() : basename(absPath);
    const rec: ViewerRecord = { id, path: absPath, title, format, content };
    this.viewers.set(id, rec);
    return rec;
  }

  /** viewer を閉じる。存在すれば true。 */
  close(id: string): boolean {
    return this.viewers.delete(id);
  }

  /** 現在の viewer 一覧（broadcast 用・content 込み）。 */
  list(): ViewerRecord[] {
    return [...this.viewers.values()];
  }
}
