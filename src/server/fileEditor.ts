// ボスが UI からファイル（主に env）を書き換えるための中核（パス検証・読み出し・保存・控え・記録）。
//
// 経路は 2 本だけ。どちらも**本文を書くのはボスのブラウザ**で、AI が本文を渡す口は作らない:
//  1. ボスの UI 操作: WS `fileEditOpen` → load() → `fileEditLoaded`（要求した接続にだけ返す）
//                    WS `fileEditSave` → save() → `fileEditSaved`
//  2. master の依頼: MCP `request_file_edit` → POST /control/file-edit-request → FileEditRequests
//                    → チャットに入力カード（鍵名だけ）→ ボスが入力して 1. の save() で保存
//                    → master には「保存した」という結果だけを通知する（値は渡さない）
//
// セキュリティ（viewerRegistry.ts の resolveViewerPath と同じ考え方を書き込み向けに厳しくしたもの）:
//  - フルパス（絶対パス・`~` 可）だけを受け、`..` を含むパスはそもそも拒否する。
//  - 許可ルート（env EBI_EDIT_ROOTS・既定 `$HOME/workspace:$HOME/.config`）の**実体（realpath）**配下に限定。
//    既にあるファイルは realpath で、新規作成は「いちばん近い既存の祖先」の realpath で包含判定する
//    （シンボリックリンクで許可ルートの外へ抜ける書き込みを防ぐ）。親フォルダを作った後にも再判定する。
//  - 通常ファイルだけ・サイズ上限あり（既定 1MB・EBI_EDIT_MAX_BYTES）・NUL を含む（バイナリ）ものは扱わない。
//  - 上書きは「開いたときの sha256」と現物が一致するときだけ（他所での変更を黙って潰さない）。
//    新規作成は排他フラグ（wx）で書くので、間に生えたファイルを上書きしない。
//  - 上書きは同じフォルダの一時ファイルへ書いてから rename（途中で落ちても半端なファイルを残さない）。
//    パーミッションは元のファイルのものを引き継ぐ。新規の秘密ファイルは 0600。
//  - 書き込みの記録（`.ebi-team/file-edits.jsonl`）は「いつ・どのファイルを・誰が・どうした」だけ。値は書かない。

import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { FileEditSaveSummary, FileEditView } from "../shared/protocol.ts";
import { JsonlLogger } from "./jsonlLog.ts";

/** 本文のサイズ上限の既定（バイト）。env EBI_EDIT_MAX_BYTES で上書き可。 */
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** 検証エラー（理由をそのまま UI / 制御API の 400 に出してよいもの）。 */
export class FileEditError extends Error {}

/** 開いた後に他所で書き換わっていた（保存を拒否した）。UI は開き直しを促す。 */
export class FileEditConflictError extends FileEditError {}

/** `~` / `$HOME` / `${HOME}` を展開する。 */
function expandHome(input: string): string {
  let s = input;
  if (s === "~" || s.startsWith("~/")) s = homedir() + s.slice(1);
  return s.replace(/\$\{?HOME\}?/g, homedir());
}

/**
 * 書き込みを許す許可ルート。
 * - env EBI_EDIT_ROOTS があれば `:` 区切りで解釈（`~`/`$HOME` 展開）
 * - 無ければ `$HOME/workspace` と `$HOME/.config`（env を置く場所）
 * open_viewer の EBI_VIEWER_ROOTS とは**別の設定**にしてある（読めることと書けることを分ける）。
 */
export function defaultEditRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.EBI_EDIT_ROOTS;
  const list = raw
    ? raw.split(":").map((s) => s.trim()).filter(Boolean)
    : [join(homedir(), "workspace"), join(homedir(), ".config")];
  return list.map((p) => resolve(expandHome(p)));
}

/**
 * 秘密を含みそうなファイルか（UI が既定で伏せ字にするかの判定。書き込みの可否には使わない）。
 * .env / .env.local / prd.env / .dev.vars / *.pem / *.key / credentials / secret / token などを拾う。
 */
export function isSecretPath(p: string): boolean {
  const name = basename(p).toLowerCase();
  return (
    /(^|[._-])env($|[._-])/.test(name) ||
    name.endsWith(".envrc") ||
    name === ".dev.vars" ||
    name.startsWith(".dev.vars.") ||
    /\.(pem|key|p12|pfx)$/.test(name) ||
    /^id_(rsa|ed25519|ecdsa|dsa)/.test(name) ||
    /(secret|credential|token|password|passwd)/.test(name) ||
    name === ".npmrc" ||
    name === ".netrc" ||
    name === ".pypirc"
  );
}

/** 本文の sha256（16 進）。 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** realPath が realRoots のいずれかの配下か（ルートそのものはファイルになり得ないので配下のみ）。 */
function isUnderRoots(realPath: string, realRoots: readonly string[]): boolean {
  return realRoots.some((r) => realPath.startsWith(r.endsWith(sep) ? r : r + sep));
}

/** 実在する許可ルートを realpath で解決する（存在しないルートは除外）。 */
async function resolveRealRoots(roots: readonly string[]): Promise<string[]> {
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

/** 書き込み先の解決結果。 */
export interface EditTarget {
  /** 実際に読み書きする絶対パス（既存ならシンボリックリンク解決後）。 */
  realPath: string;
  exists: boolean;
  /** 作る必要がある親フォルダ（浅い順・実体パス）。 */
  missingDirs: string[];
}

/**
 * 編集対象のパスを検証して、実際に書く場所を確定する。失敗は FileEditError を throw。
 * 存在の有無に関わらず、許可ルートの実体の外へ出るパスはすべて拒否する。
 */
export async function resolveEditTarget(rawPath: unknown, roots: readonly string[]): Promise<EditTarget> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new FileEditError("path（文字列）は必須です");
  }
  const trimmed = rawPath.trim();
  if (trimmed.includes("\0")) throw new FileEditError("パスに使えない文字が含まれています");
  const expanded = expandHome(trimmed);
  if (!isAbsolute(expanded)) {
    throw new FileEditError(`フルパスで指定してください（例: ~/.config/app/prd.env）: ${trimmed}`);
  }
  // `..` は正規化で消せるが、意図の分からない指定はそもそも受けない。
  if (expanded.split(/[\\/]+/).includes("..")) {
    throw new FileEditError(`「..」を含むパスは指定できません: ${trimmed}`);
  }
  if (/[\\/]$/.test(expanded)) throw new FileEditError(`ファイルのパスを指定してください: ${trimmed}`);
  const absPath = resolve(expanded);

  const realRoots = await resolveRealRoots(roots);
  const outside = (p: string) =>
    new FileEditError(
      `許可ルートの外には書けません: ${p}（許可ルート: ${roots.join(", ") || "(なし)"}。EBI_EDIT_ROOTS で設定）`,
    );

  // 既にあるか（シンボリックリンク自体も「ある」に含める）。
  const own = await lstat(absPath).catch(() => null);
  if (own) {
    let real: string;
    try {
      real = await realpath(absPath);
    } catch {
      throw new FileEditError(`リンク先が存在しません: ${absPath}`);
    }
    if (!isUnderRoots(real, realRoots)) throw outside(real);
    const st = await stat(real);
    if (!st.isFile()) throw new FileEditError(`通常のファイルではありません: ${real}`);
    return { realPath: real, exists: true, missingDirs: [] };
  }

  // 新規作成: いちばん近い既存の祖先を探し、その実体で包含判定する。
  const missing: string[] = [];
  let ancestor = dirname(absPath);
  for (;;) {
    const st = await lstat(ancestor).catch(() => null);
    if (st) break;
    missing.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) throw outside(absPath);
    ancestor = parent;
  }
  let realAncestor: string;
  try {
    realAncestor = await realpath(ancestor);
  } catch {
    throw new FileEditError(`フォルダにアクセスできません: ${ancestor}`);
  }
  const ancestorStat = await stat(realAncestor);
  if (!ancestorStat.isDirectory()) throw new FileEditError(`フォルダではありません: ${realAncestor}`);
  const realPath = join(realAncestor, ...missing, basename(absPath));
  // 祖先そのものが許可ルートでもよい（ルート直下へ新規作成）ので、包含は最終パスで見る。
  if (!isUnderRoots(realPath, realRoots)) throw outside(realPath);
  const missingDirs: string[] = [];
  let cur = realAncestor;
  for (const seg of missing) {
    cur = join(cur, seg);
    missingDirs.push(cur);
  }
  return { realPath, exists: false, missingDirs };
}

/** 書き込み記録の 1 件（値は持たない）。 */
export interface FileEditAuditEntry {
  action: "create" | "update";
  path: string;
  /** 誰の操作か（"boss-ui" / "boss-ui:request:<依頼 id>"）。 */
  actor: string;
  /** 依頼元（request_file_edit を出した送り手）。UI 単独の操作では null。 */
  requestedBy: string | null;
  bytes: number;
  backupPath: string | null;
  createdDirs: string[];
}

/** 保存の入力。 */
export interface FileEditSaveInput {
  path: string;
  content: unknown;
  baseHash: string | null;
  createDirs: boolean;
  backup: boolean;
  actor: string;
  requestedBy?: string | null;
}

export interface FileEditorOptions {
  roots?: string[];
  maxBytes?: number;
  /** 書き込み記録の出力先（未指定なら記録しない＝テスト用）。 */
  auditPath?: string | null;
  /** 控えのファイル名に使う時刻（テスト用）。 */
  now?: () => Date;
}

/** 控えのファイル名の時刻部分（ローカル時刻 YYYYMMDD-HHMMSS。既存の .bak-20260906 命名に揃える）。 */
export function backupStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** UTF-8 のテキストとして扱えるか（NUL を含むものはバイナリとみなす）。 */
function assertText(text: string, where: string): void {
  if (text.includes("\0")) throw new FileEditError(`テキストではないファイルは編集できません: ${where}`);
}

/**
 * ファイル編集の本体。load / save と書き込み記録を持つ。
 * index.ts が WS から呼ぶ（本文は呼び出し元の接続にだけ返す）。
 */
export class FileEditor {
  private readonly roots: string[];
  readonly maxBytes: number;
  private readonly audit: JsonlLogger | null;
  private readonly now: () => Date;

  constructor(opts: FileEditorOptions = {}) {
    this.roots = opts.roots ?? defaultEditRoots();
    this.maxBytes = opts.maxBytes ?? (Number(process.env.EBI_EDIT_MAX_BYTES) || DEFAULT_MAX_BYTES);
    this.now = opts.now ?? (() => new Date());
    if (opts.auditPath) {
      // 記録は 5MB で 1 世代ローテート（中身は 1 行 200 バイト程度なので数万件ぶん）。
      this.audit = new JsonlLogger("file-edit", 5 * 1024 * 1024);
      this.audit.configure(opts.auditPath);
    } else {
      this.audit = null;
    }
  }

  getRoots(): string[] {
    return [...this.roots];
  }

  /** 検証だけ行う（request_file_edit の受付時に、ルート外の依頼を早めに弾くため）。 */
  resolve(rawPath: unknown): Promise<EditTarget> {
    return resolveEditTarget(rawPath, this.roots);
  }

  /** 編集画面に出す 1 ファイル分を読む。 */
  async load(rawPath: unknown): Promise<FileEditView> {
    const target = await resolveEditTarget(rawPath, this.roots);
    const secret = isSecretPath(target.realPath);
    if (!target.exists) {
      return {
        path: target.realPath,
        exists: false,
        content: null,
        baseHash: null,
        secret,
        missingDirs: target.missingDirs,
        size: 0,
      };
    }
    const st = await stat(target.realPath);
    if (st.size > this.maxBytes) {
      throw new FileEditError(`ファイルが大きすぎます: ${st.size} バイト（上限 ${this.maxBytes} バイト）`);
    }
    const content = await readFile(target.realPath, "utf8");
    assertText(content, target.realPath);
    return {
      path: target.realPath,
      exists: true,
      content,
      baseHash: hashContent(content),
      secret,
      missingDirs: [],
      size: st.size,
    };
  }

  /** 保存する。結果に本文は含めない。 */
  async save(input: FileEditSaveInput): Promise<FileEditSaveSummary> {
    if (typeof input.content !== "string") throw new FileEditError("content（文字列）は必須です");
    const content = input.content;
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.maxBytes) {
      throw new FileEditError(`内容が大きすぎます: ${bytes} バイト（上限 ${this.maxBytes} バイト）`);
    }
    assertText(content, "入力内容");

    const target = await resolveEditTarget(input.path, this.roots);
    const realRoots = await resolveRealRoots(this.roots);

    if (target.exists) {
      // 開いたときの本文と現物が一致するときだけ上書きする。
      const current = await readFile(target.realPath, "utf8");
      if (input.baseHash == null || input.baseHash !== hashContent(current)) {
        throw new FileEditConflictError(
          input.baseHash == null
            ? `ファイルが新しく作られています。開き直してください: ${target.realPath}`
            : `開いた後にファイルが書き換わっています。開き直してください: ${target.realPath}`,
        );
      }
    } else if (input.baseHash != null) {
      throw new FileEditConflictError(`開いた後にファイルが消えています。開き直してください: ${target.realPath}`);
    }

    const secret = isSecretPath(target.realPath);
    const createdDirs: string[] = [];
    if (target.missingDirs.length > 0) {
      if (!input.createDirs) {
        throw new FileEditError(
          `親フォルダがありません（作成の確認が必要です）: ${target.missingDirs[0]}`,
        );
      }
      for (const dir of target.missingDirs) {
        // 1 段ずつ作り、作るたびに実体が許可ルート配下であることを確かめる（途中に生えたリンク対策）。
        await mkdir(dir, { mode: secret ? 0o700 : 0o755 }).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "EEXIST") throw err;
        });
        const real = await realpath(dir);
        if (!isUnderRoots(real, realRoots)) {
          throw new FileEditError(`許可ルートの外には書けません: ${real}`);
        }
        createdDirs.push(dir);
      }
    }
    // 親フォルダの実体を最終確認（作成後・既存どちらも）。
    const realParent = await realpath(dirname(target.realPath));
    if (!isUnderRoots(join(realParent, basename(target.realPath)), realRoots)) {
      throw new FileEditError(`許可ルートの外には書けません: ${target.realPath}`);
    }

    let backupPath: string | null = null;
    if (target.exists) {
      const st = await stat(target.realPath);
      const mode = st.mode & 0o777;
      if (input.backup) {
        backupPath = await this.makeBackup(target.realPath, mode);
      }
      // 同じフォルダの一時ファイルへ書いてから rename（原子的に置き換える）。
      const tmp = join(
        dirname(target.realPath),
        `.${basename(target.realPath)}.ebi-edit-${randomBytes(4).toString("hex")}`,
      );
      try {
        await writeFile(tmp, content, { encoding: "utf8", mode, flag: "wx" });
        await chmod(tmp, mode); // umask で削られた分を戻す
        await rename(tmp, target.realPath);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
    } else {
      try {
        await writeFile(target.realPath, content, {
          encoding: "utf8",
          mode: secret ? 0o600 : 0o644,
          flag: "wx",
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new FileEditConflictError(`開いた後にファイルが作られています。開き直してください: ${target.realPath}`);
        }
        throw err;
      }
    }

    const summary: FileEditSaveSummary = {
      path: target.realPath,
      action: target.exists ? "update" : "create",
      bytes,
      backupPath,
      createdDirs,
    };
    this.record({
      action: summary.action,
      path: summary.path,
      actor: input.actor,
      requestedBy: input.requestedBy ?? null,
      bytes,
      backupPath,
      createdDirs,
    });
    return summary;
  }

  /** 書き込み記録に 1 件残す（値は持たない）。 */
  private record(entry: FileEditAuditEntry): void {
    this.audit?.log({
      event: `file-${entry.action}`,
      level: "info",
      msg: `${entry.action === "create" ? "新規作成" : "上書き"}: ${entry.path}（${entry.actor}）`,
      ...entry,
    });
  }

  /** テスト用: 記録の書き込み完了を待つ。 */
  flush(): Promise<void> {
    return this.audit?.flush() ?? Promise.resolve();
  }

  /** `<file>.bak-YYYYMMDD-HHMMSS` に控えをとる（同名があれば -2, -3 … を付ける）。 */
  private async makeBackup(realPath: string, mode: number): Promise<string> {
    const base = `${realPath}.bak-${backupStamp(this.now())}`;
    for (let n = 1; n <= 50; n += 1) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      try {
        await copyFile(realPath, candidate, fsConstants.COPYFILE_EXCL);
        await chmod(candidate, mode); // 控えも元と同じ権限（秘密ファイルの控えを広く読ませない）
        return candidate;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    throw new FileEditError(`控えのファイル名を決められません: ${base}`);
  }
}

// ===== master からの依頼（request_file_edit）=====

/** 依頼 1 件。 */
export interface FileEditRequest {
  id: string;
  /** 書き込み先（受付時に検証済みの実体パス）。 */
  path: string;
  keys: string[];
  note: string | null;
  /** 依頼した送り手。 */
  from: string;
  createdAt: number;
}

/** 依頼が決着したときの通知先（index.ts がチャットと master への結果通知に配線する）。 */
export interface FileEditRequestHandlers {
  /** 依頼が立った（チャットに入力カードを出す）。 */
  onRequest(req: FileEditRequest): void;
  /**
   * 依頼が決着した。summary は master へそのまま渡せる 1 行（値は含まない）。
   * notify=false は「依頼がもう無い」ことをカードへ伝えるだけ（master へは送らない）。
   */
  onSettled(
    req: FileEditRequest | { id: string; from: string | null; path: string | null },
    outcome: "saved" | "cancelled" | "discarded",
    summary: string,
    notify: boolean,
  ): void;
}

/** 鍵名の形（envEdit.ts の isValidEnvKey と同じ）。 */
const REQUEST_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * master からの「このファイルにこの鍵を入れてください」の台帳（メモリのみ）。
 * サーバ再起動で消える。消えた依頼のカードを押したときは discarded として畳む。
 */
export class FileEditRequests {
  private readonly pending = new Map<string, FileEditRequest>();
  private counter = 0;

  constructor(
    private readonly editor: FileEditor,
    private readonly handlers: FileEditRequestHandlers,
  ) {}

  /** 依頼を受け付ける。パスが許可ルート外・鍵名が不正なら FileEditError。 */
  async create(input: { path: unknown; keys?: unknown; note?: unknown; from?: unknown }): Promise<{
    request: FileEditRequest;
    exists: boolean;
  }> {
    const target = await this.editor.resolve(input.path);
    const keys: string[] = [];
    if (input.keys !== undefined && input.keys !== null) {
      if (!Array.isArray(input.keys)) throw new FileEditError("keys は文字列の配列で指定してください");
      for (const k of input.keys) {
        if (typeof k !== "string" || !REQUEST_KEY_RE.test(k)) {
          throw new FileEditError(`鍵名が不正です: ${String(k)}（英数字と _ のみ・先頭は数字以外）`);
        }
        if (!keys.includes(k)) keys.push(k);
      }
      if (keys.length > 50) throw new FileEditError("keys は 50 個までです");
    }
    const note =
      typeof input.note === "string" && input.note.trim() !== "" ? input.note.trim().slice(0, 1000) : null;
    const from = typeof input.from === "string" && input.from.trim() !== "" ? input.from.trim() : "master";
    this.counter += 1;
    const request: FileEditRequest = {
      id: `fedit-${Date.now().toString(36)}-${this.counter}`,
      path: target.realPath,
      keys,
      note,
      from,
      createdAt: Date.now(),
    };
    this.pending.set(request.id, request);
    this.handlers.onRequest(request);
    return { request, exists: target.exists };
  }

  get(id: string): FileEditRequest | null {
    return this.pending.get(id) ?? null;
  }

  /** 未決着の件数（テスト・表示用）。 */
  get size(): number {
    return this.pending.size;
  }

  /** 保存できた。master へは「保存した」と鍵名・パスだけを伝える。 */
  markSaved(id: string, saved: FileEditSaveSummary): void {
    const req = this.pending.get(id);
    if (!req) return;
    this.pending.delete(id);
    const parts = [
      `ボスが ${saved.path} を${saved.action === "create" ? "新規作成" : "保存"}しました`,
      req.keys.length > 0 ? `（鍵: ${req.keys.map((k) => `\`${k}\``).join(", ")}）` : "",
      saved.backupPath ? `。控え: ${saved.backupPath}` : "",
    ];
    this.handlers.onSettled(req, "saved", parts.join(""), true);
  }

  /** ボスが断った。 */
  cancel(id: string): boolean {
    const req = this.pending.get(id);
    if (!req) {
      this.handlers.onSettled({ id, from: null, path: null }, "discarded", "依頼は既にありません", false);
      return false;
    }
    this.pending.delete(id);
    this.handlers.onSettled(req, "cancelled", `ボスが ${req.path} の編集依頼を見送りました`, true);
    return true;
  }

  /** 未知の依頼 id（サーバ再起動で消えた等）を押されたとき、カードを畳む。 */
  forgetUnknown(id: string): void {
    if (this.pending.has(id)) return;
    this.handlers.onSettled(
      { id, from: null, path: null },
      "discarded",
      "依頼は無効です（サーバ再起動などで破棄されました）",
      false,
    );
  }
}
