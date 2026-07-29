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
// - 永続化（サーバ再起動をまたぐ復元）:
//   - agent 側 Registry の流儀に合わせ、一覧が変わるたび .ebi-team/viewers.json へ JSON ダンプ。
//   - content は保存しない（復元時にファイルを読み直す＝古いスナップショットを蘇らせない）。
//   - 復元は必ず open() 経路＝resolveViewerPath の検証を通す。消えたファイルや検証NGはスキップ。

import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve, dirname, extname, basename, join, sep } from "node:path";
import type { ViewerRecord, ViewerFormat, DirEntry, DirListing } from "../shared/protocol.ts";

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
  /** 一覧ダンプの保存先（未指定は env or 既定 `<cwd>/.ebi-team/viewers.json`）。 */
  dumpPath?: string;
}

/** viewers.json に保存する 1 件分（content は保存しない＝復元時に読み直す）。 */
interface ViewerDumpEntry {
  id: string;
  path: string;
  title: string;
  format: ViewerFormat;
}

/** viewer 一覧ダンプの既定パス。agent 側 registry.json と同じ `.ebi-team/` 配下に置く。 */
export function defaultViewerDumpPath(): string {
  return process.env.EBI_VIEWER_DUMP_PATH ?? join(process.cwd(), ".ebi-team", "viewers.json");
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
  private readonly dumpPath: string;

  constructor(opts: ViewerRegistryOptions = {}) {
    this.roots = opts.roots ?? defaultViewerRoots();
    this.maxBytes =
      opts.maxBytes ?? (Number(process.env.EBI_VIEWER_MAX_BYTES) || DEFAULT_MAX_BYTES);
    this.dumpPath = opts.dumpPath ?? defaultViewerDumpPath();
  }

  /** 一覧ダンプの保存先（表示・ログ用）。 */
  getDumpPath(): string {
    return this.dumpPath;
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
    const rec = await this.openEntry(params);
    void this.dump();
    return rec;
  }

  /**
   * open の実体。復元時は既存 id を引き継ぎたいので forcedId を受ける。
   * ダンプは呼び出し側が行う（復元では全件登録後に 1 回だけ書けばよいため）。
   */
  private async openEntry(
    params: { path: string; title?: string },
    forcedId?: string,
  ): Promise<ViewerRecord> {
    const { realPath, absPath, format } = await resolveViewerPath(
      params.path,
      this.roots,
      this.maxBytes,
    );
    const content = await readFile(realPath, "utf8");
    const id = forcedId ?? `viewer-${++this.seq}`;
    const title =
      params.title && params.title.trim() ? params.title.trim() : basename(absPath);
    const rec: ViewerRecord = { id, path: absPath, title, format, content };
    this.viewers.set(id, rec);
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

  /** viewer を閉じる。存在すれば true。 */
  close(id: string): boolean {
    const existed = this.viewers.delete(id);
    if (existed) void this.dump();
    return existed;
  }

  /** 現在の viewer 一覧（broadcast 用・content 込み）。 */
  list(): ViewerRecord[] {
    return [...this.viewers.values()];
  }

  /**
   * 一覧を dumpPath へ JSON 書き出しする（open/close のたび）。
   * content は保存しない。書き込み失敗はサーバを落とさず警告のみ（agent 側 Registry と同じ流儀）。
   */
  private async dump(): Promise<void> {
    try {
      await mkdir(dirname(this.dumpPath), { recursive: true });
      const snapshot = {
        dumpedAt: new Date().toISOString(),
        viewers: [...this.viewers.values()].map(
          ({ id, path, title, format }): ViewerDumpEntry => ({ id, path, title, format }),
        ),
      };
      await writeFile(this.dumpPath, JSON.stringify(snapshot, null, 2), "utf8");
    } catch (err) {
      console.warn("[viewer] dump 失敗:", err);
    }
  }

  /**
   * dumpPath から前回の viewer 一覧を復元する（サーバ起動時に 1 回）。
   * 各エントリは通常の open 経路（resolveViewerPath の許可ルート/拡張子/サイズ/symlink 検証）を通す。
   * ファイルが消えている・検証NGのエントリはスキップして理由を返す（サーバは落とさない）。
   * 戻り値は呼び出し側のログ/broadcast 判断用。
   */
  async restore(): Promise<{ restored: ViewerRecord[]; skipped: { path: string; reason: string }[] }> {
    const restored: ViewerRecord[] = [];
    const skipped: { path: string; reason: string }[] = [];

    let entries: ViewerDumpEntry[];
    try {
      const raw = await readFile(this.dumpPath, "utf8");
      const parsed = JSON.parse(raw) as { viewers?: unknown };
      if (!Array.isArray(parsed?.viewers)) return { restored, skipped };
      entries = parsed.viewers as ViewerDumpEntry[];
    } catch (err) {
      // ダンプ無し（初回起動）は正常系。壊れている場合のみ警告して空復元にする。
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.warn("[viewer] dump 読み込み失敗（復元をスキップ）:", err);
      }
      return { restored, skipped };
    }

    for (const e of entries) {
      if (!e || typeof e.path !== "string") continue;
      try {
        const rec = await this.openEntry(
          { path: e.path, title: typeof e.title === "string" ? e.title : undefined },
          typeof e.id === "string" && e.id ? e.id : undefined,
        );
        restored.push(rec);
        // 復元 id と採番カウンタが衝突しないよう seq を進める（`viewer-N` の N を吸収）。
        const n = Number(/^viewer-(\d+)$/.exec(rec.id)?.[1]);
        if (Number.isFinite(n) && n > this.seq) this.seq = n;
      } catch (err) {
        skipped.push({ path: e.path, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    // 復元でスキップが出た分をダンプへ反映しておく（次回起動で再試行しない）。
    if (skipped.length > 0) void this.dump();
    return { restored, skipped };
  }
}
