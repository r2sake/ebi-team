// viewer（読み取り専用の md/txt/画像プレビュー）を保持するコレクション。
//
// 設計方針:
// - AgentRecord（PTY プロセス前提）を汚さず、viewer は「プロセスを持たない UI エンティティ」
//   として別コレクションで持つ。1 件 = { id, path, title, format, content }。
// - 起動口は master 専用 MCP `open_viewer` → POST /control/open-viewer → open()。
//   閉じるのは WS `{type:"closeViewer"}` → close()。いずれも変更後に viewers を再 broadcast する。
// - パス安全（外部参照の制限・読み取り専用）:
//   - EBI_VIEWER_ROOTS（`:` 区切り・未設定時は `$HOME/workspace`）配下に限定。
//   - realpath でシンボリックリンク脱出を防止（実体が許可ルート配下にあること）。
//   - 拡張子は .md / .markdown / .txt / .png / .jpg / .jpeg / .webp / .gif に限定、
//     サイズ上限あり（テキストと画像で別枠）、書き込み口は作らない。
// - 画像（format="image"）:
//   - content には載せない（WS の viewers broadcast は全接続へ流れるため、バイナリを base64 で
//     詰めるとペイロードが膨らむ）。バイト列は readImage() → `GET /control/viewer-file?id=` で配信。
//   - 配信時にも resolveViewerPath で再検証する（open 後にパスが差し替わっても許可範囲を外れない）。
// - 永続化（サーバ再起動をまたいでタブを復元する）:
//   - open/close のたびに `.ebi-team/viewers.json` へ `{id, path, title, openedAt}` を atomic 書き出し。
//   - 起動時 restore() で読み直し、同じ id/openedAt のまま再登録する（content は読み直したスナップショット）。
//   - ファイル欠損・許可ルート外・拡張子/サイズ違反のエントリは warn して skip し、viewers.json から掃除する
//     （fail-soft: 起動は止めない）。

import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve, dirname, extname, basename, join, sep } from "node:path";
import type { ViewerRecord, ViewerFormat, DirEntry, DirListing } from "../shared/protocol.ts";

/** viewer に許可する拡張子とレンダリング形式の対応。 */
const ALLOWED_EXT: Record<string, ViewerFormat> = {
  ".md": "md",
  ".markdown": "md",
  ".txt": "txt",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
};

/** 画像拡張子 → Content-Type。viewer-file 配信で使う（ALLOWED_EXT の image と同じ集合）。 */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** 拡張子から画像の Content-Type を引く（画像以外は null）。 */
export function imageMimeForPath(p: string): string | null {
  return IMAGE_MIME[extname(p).toLowerCase()] ?? null;
}

/** テキスト（md/txt）のサイズ上限の既定（バイト）。env EBI_VIEWER_MAX_BYTES で上書き可。 */
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1MB

/**
 * 画像のサイズ上限の既定（バイト）。env EBI_VIEWER_MAX_IMAGE_BYTES で上書き可。
 * テキストの 1MB では生成 PNG が普通に弾かれるため枠を分ける。
 */
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB

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
  /** テキスト（md/txt）のサイズ上限（バイト・未指定は env or 既定 1MB）。 */
  maxBytes?: number;
  /** 画像のサイズ上限（バイト・未指定は env or 既定 8MB）。 */
  maxImageBytes?: number;
  /**
   * 永続化先（`.ebi-team/viewers.json`）。未指定なら永続化しない（従来どおりメモリのみ）。
   * テストでは temp dir 配下を渡す。
   */
  storePath?: string;
}

/** viewers.json の 1 エントリ（content は保存しない＝復元時にファイルから読み直す）。 */
interface PersistedViewer {
  id: string;
  path: string;
  title: string;
  openedAt: number;
}

/** viewers.json 全体。version は将来の形式変更に備えた識別子。 */
interface ViewerStoreFile {
  version: 1;
  savedAt: string;
  viewers: PersistedViewer[];
}

/** restore() の結果（起動ログ用）。 */
export interface ViewerRestoreResult {
  restored: ViewerRecord[];
  /** 復元できず掃除したエントリ（path と理由）。 */
  skipped: { path: string; reason: string }[];
}

/** `viewer-<n>` から n を取り出す（採番の続きを決めるため）。合致しなければ 0。 */
function seqOfViewerId(id: string): number {
  const m = /^viewer-(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

/**
 * 検証エラー。制御API 側で 400 に振り分けるため識別可能にしておく。
 */
export class ViewerPathError extends Error {}

/**
 * roots の各要素を realpath 解決して返す（存在しないルートは黙って除外）。
 * シンボリックリンク脱出防止のため、包含判定は必ず実体（realpath）基準で行う。
 */
async function resolveRealRoots(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    try {
      out.push(await realpath(root));
    } catch {
      // 存在しないルートはスキップ。
    }
  }
  return out;
}

/** realPath が realRoots のいずれかの配下（またはルート自身）か。 */
function isWithinRoots(realPath: string, realRoots: string[]): boolean {
  return realRoots.some((r) => realPath === r || realPath.startsWith(r + sep));
}

/**
 * viewer 用にパスを検証し、実パス・形式・サイズを確定して返す。
 * DOM/ファイル読み込みの前段（純粋にパス安全性のみ）を独立させ、単体テストしやすくする。
 * 失敗時は ViewerPathError を throw する。
 */
export async function resolveViewerPath(
  rawPath: string,
  roots: string[],
  maxBytes: number,
  maxImageBytes: number = maxBytes,
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
  const realRoots = await resolveRealRoots(roots);
  if (!isWithinRoots(realPath, realRoots)) {
    throw new ViewerPathError(
      `許可ルート外のパスです: ${realPath}（許可ルート: ${roots.join(", ") || "(なし)"}。EBI_VIEWER_ROOTS で設定）`,
    );
  }

  // 通常ファイル & サイズ上限。
  const st = await stat(realPath);
  if (!st.isFile()) {
    throw new ViewerPathError(`通常ファイルではありません: ${realPath}`);
  }
  // サイズ上限はテキストと画像で別枠（画像は生成 PNG が 1MB を普通に超える）。
  const limit = format === "image" ? maxImageBytes : maxBytes;
  if (st.size > limit) {
    throw new ViewerPathError(`ファイルが大きすぎます: ${st.size} バイト（上限 ${limit} バイト）`);
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
  private readonly maxImageBytes: number;
  private readonly storePath: string | null;
  /** 永続化の直列化キュー（open/close が連続しても書き込み順を保つ）。 */
  private persistChain: Promise<void> = Promise.resolve();

  constructor(opts: ViewerRegistryOptions = {}) {
    this.roots = opts.roots ?? defaultViewerRoots();
    this.maxBytes =
      opts.maxBytes ?? (Number(process.env.EBI_VIEWER_MAX_BYTES) || DEFAULT_MAX_BYTES);
    this.maxImageBytes =
      opts.maxImageBytes ??
      (Number(process.env.EBI_VIEWER_MAX_IMAGE_BYTES) || DEFAULT_MAX_IMAGE_BYTES);
    this.storePath = opts.storePath ?? null;
  }

  /** 現在の許可ルート（表示・ログ用）。 */
  getRoots(): string[] {
    return [...this.roots];
  }

  /**
   * 現在のサイズ上限（テキスト / 画像）。
   * チャットへの画像共有（PR-M10・src/server/chatImages.ts）が **open_viewer とまったく同じ枠**で
   * 検証するために公開している（env の解釈をもう 1 か所に書かない）。
   */
  get limits(): { maxBytes: number; maxImageBytes: number } {
    return { maxBytes: this.maxBytes, maxImageBytes: this.maxImageBytes };
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
      this.maxImageBytes,
    );
    // 画像は content に載せない（バイト列は /control/viewer-file で配信する）。
    const content = format === "image" ? "" : await readFile(realPath, "utf8");
    const id = `viewer-${++this.seq}`;
    const title =
      params.title && params.title.trim() ? params.title.trim() : basename(absPath);
    const rec: ViewerRecord = { id, path: absPath, title, format, content, openedAt: Date.now() };
    this.viewers.set(id, rec);
    await this.persist();
    return rec;
  }

  /**
   * ファイルピッカー用にディレクトリを列挙する（ユーザーが AI を介さず自分で md を開くための経路）。
   * rawPath 省略時は「許可ルートそのものの一覧」を返す。指定時は許可ルート配下に限定して検証し、
   * 実体（realpath）基準でルート外・シンボリックリンク脱出・非ディレクトリを拒否する。
   * ルート外の存在有無は漏らさない（検証失敗は汎用の ViewerPathError）。
   */
  async listDir(rawPath?: string): Promise<DirListing> {
    const realRoots = await resolveRealRoots(this.roots);

    // ---- ルート一覧（最上位）----
    // rawPath 未指定・空なら、許可ルートのうち実在するものを「ディレクトリ」として列挙する。
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      const entries: DirEntry[] = realRoots.map((r) => ({ name: r, path: r, type: "dir" }));
      return { atRoot: true, cwd: "", up: null, entries, roots: [...this.roots] };
    }

    // ---- 指定ディレクトリの列挙 ----
    const expanded = expandHome(rawPath.trim());
    const absPath = isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);

    // 実体解決（存在しない・アクセス不可はルート外と同じ汎用エラーにして情報を漏らさない）。
    let realPath: string;
    try {
      realPath = await realpath(absPath);
    } catch {
      throw new ViewerPathError("ディレクトリにアクセスできません（許可ルート配下のみ閲覧できます）");
    }
    if (!isWithinRoots(realPath, realRoots)) {
      throw new ViewerPathError("許可ルート外のディレクトリです（EBI_VIEWER_ROOTS 配下のみ閲覧できます）");
    }
    const dirStat = await stat(realPath);
    if (!dirStat.isDirectory()) {
      throw new ViewerPathError("ディレクトリではありません");
    }

    // 子エントリを列挙。symlink は実体を stat して種別判定（壊れリンク等は静かに除外）。
    // 表示のみで、実際の降下/オープン時に listDir/open が realpath 基準で再検証するため安全。
    const dirents = await readdir(realPath, { withFileTypes: true });
    const dirs: DirEntry[] = [];
    const files: DirEntry[] = [];
    for (const d of dirents) {
      const childPath = join(realPath, d.name);
      let isDir = d.isDirectory();
      let isFile = d.isFile();
      if (d.isSymbolicLink()) {
        try {
          const st = await stat(childPath); // symlink 先を解決。
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // 壊れた symlink はスキップ。
        }
      }
      if (isDir) {
        dirs.push({ name: d.name, path: childPath, type: "dir" });
      } else if (isFile) {
        const ext = extname(d.name).toLowerCase();
        files.push({ name: d.name, path: childPath, type: "file", eligible: Boolean(ALLOWED_EXT[ext]) });
      }
    }
    const byName = (a: DirEntry, b: DirEntry) => a.name.localeCompare(b.name, "ja");
    dirs.sort(byName);
    files.sort(byName);

    // 「上へ」の遷移先: ルート自身なら "" (ルート一覧へ)、それ以外は親ディレクトリ。
    const isRootItself = realRoots.some((r) => r === realPath);
    const up = isRootItself ? "" : dirname(realPath);

    return { atRoot: false, cwd: realPath, up, entries: [...dirs, ...files], roots: [...this.roots] };
  }

  /**
   * viewer を閉じる。存在すれば true。
   * 呼び出し元（WS ハンドラ）が同期のため、永続化は fire-and-forget で走らせる
   * （書き込み完了を待ちたい場合は flush() を await する）。
   */
  close(id: string): boolean {
    const existed = this.viewers.delete(id);
    if (existed) void this.persist();
    return existed;
  }

  /** id で viewer を引く（無ければ undefined）。 */
  get(id: string): ViewerRecord | undefined {
    return this.viewers.get(id);
  }

  /**
   * 画像 viewer のバイト列を読む（`GET /control/viewer-file?id=` の実体）。
   * - クライアントからは **id しか受けない**（生パスを受けない＝パストラバーサルの入口を作らない）。
   * - 未登録 id・画像以外の viewer は null（呼び出し側で 404）。
   * - open 済みでも配信のたびに resolveViewerPath で再検証する（許可ルート・realpath・サイズ）。
   *   検証に失敗したら ViewerPathError を throw する（呼び出し側で 400）。
   */
  async readImage(id: string): Promise<{ bytes: Buffer; mime: string; path: string } | null> {
    const rec = this.viewers.get(id);
    if (!rec || rec.format !== "image") return null;
    const { realPath } = await resolveViewerPath(
      rec.path,
      this.roots,
      this.maxBytes,
      this.maxImageBytes,
    );
    const mime = imageMimeForPath(realPath);
    // resolveViewerPath が image と判定した以上ここは必ず引けるが、保険で弾く（sniff させない）。
    if (!mime) throw new ViewerPathError(`画像として配信できない拡張子です: ${realPath}`);
    return { bytes: await readFile(realPath), mime, path: rec.path };
  }

  /** 現在の viewer 一覧（broadcast 用・content 込み。画像の content は空文字）。 */
  list(): ViewerRecord[] {
    return [...this.viewers.values()];
  }

  // ===== 永続化（viewers.json）=====

  /** 進行中の永続化がすべて終わるまで待つ（テスト・終了処理用）。 */
  async flush(): Promise<void> {
    await this.persistChain;
  }

  /**
   * 現在の viewer 一覧を viewers.json へ atomic に書き出す。
   * 失敗しても運用は継続できるべきなので warn のみ（throw しない）。
   */
  private persist(): Promise<void> {
    if (!this.storePath) return Promise.resolve();
    this.persistChain = this.persistChain.then(() => this.writeStore());
    return this.persistChain;
  }

  /** tmp へ書いてから rename する（クラッシュ時に中途半端な JSON を残さない）。 */
  private async writeStore(): Promise<void> {
    const storePath = this.storePath;
    if (!storePath) return;
    const payload: ViewerStoreFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      viewers: [...this.viewers.values()].map(({ id, path, title, openedAt }) => ({
        id,
        path,
        title,
        openedAt: openedAt ?? 0,
      })),
    };
    const tmpPath = `${storePath}.tmp-${process.pid}`;
    try {
      await mkdir(dirname(storePath), { recursive: true });
      await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
      await rename(tmpPath, storePath);
    } catch (err) {
      console.warn("[viewer] viewers.json の保存に失敗:", err);
      // 失敗した tmp は残さない（次回の rename 対象にもならないが掃除しておく）。
      try {
        await unlink(tmpPath);
      } catch {
        // 無ければ何もしない。
      }
    }
  }

  /**
   * viewers.json を読み、保存されていた viewer を再登録する（サーバ起動時に 1 回）。
   * fail-soft: ファイル無し・壊れた JSON・個々のエントリ検証失敗はいずれも起動を止めず、
   * 失敗エントリは warn して skip し、掃除済みの内容で viewers.json を書き戻す。
   */
  async restore(): Promise<ViewerRestoreResult> {
    const result: ViewerRestoreResult = { restored: [], skipped: [] };
    if (!this.storePath) return result;

    let raw: string;
    try {
      raw = await readFile(this.storePath, "utf8");
    } catch {
      return result; // 未作成（初回起動）は正常系。
    }

    let entries: PersistedViewer[];
    try {
      const parsed = JSON.parse(raw) as Partial<ViewerStoreFile>;
      entries = Array.isArray(parsed?.viewers) ? (parsed.viewers as PersistedViewer[]) : [];
    } catch (err) {
      console.warn(`[viewer] viewers.json が壊れているため復元をスキップ: ${(err as Error).message}`);
      return result;
    }

    // 保存順ではなく openedAt 昇順で復元し、再起動前のタブ並びを保つ。
    const sane = entries
      .filter((e) => e && typeof e.path === "string" && e.path.trim() !== "")
      .sort((a, b) => (Number(a.openedAt) || 0) - (Number(b.openedAt) || 0));

    for (const e of sane) {
      try {
        // open と同じ検証（許可ルート・拡張子・サイズ・symlink 脱出）を通す。
        const { realPath, absPath, format } = await resolveViewerPath(
          e.path,
          this.roots,
          this.maxBytes,
          this.maxImageBytes,
        );
        const content = format === "image" ? "" : await readFile(realPath, "utf8");
        const id =
          typeof e.id === "string" && /^viewer-\d+$/.test(e.id) && !this.viewers.has(e.id)
            ? e.id
            : `viewer-${this.seq + 1}`;
        const title =
          typeof e.title === "string" && e.title.trim() ? e.title.trim() : basename(absPath);
        const rec: ViewerRecord = {
          id,
          path: absPath,
          title,
          format,
          content,
          openedAt: Number(e.openedAt) || Date.now(),
        };
        this.viewers.set(id, rec);
        this.seq = Math.max(this.seq, seqOfViewerId(id));
        result.restored.push(rec);
      } catch (err) {
        const reason = (err as Error).message;
        console.warn(`[viewer] 復元できないためスキップ: ${e.path}（${reason}）`);
        result.skipped.push({ path: e.path, reason });
      }
    }

    // skip が出た場合は掃除後の内容で書き戻す（次回起動で同じ warn を繰り返さない）。
    if (result.skipped.length > 0) await this.persist();
    return result;
  }
}
