// 固定エビ（master/supervisor）の宣言的 config（ebi-team.config.json）のロード・正規化。
//
// 設計方針:
// - ルートの `ebi-team.config.json` を読み、固定エビ定義を検証・正規化して返す。
// - cwd は `$HOME` 等の環境変数展開と相対パス解決（config 基準）を行い、存在チェックする。
// - command / args / model / permissionMode / appendSystemPrompt から
//   node-pty に渡す実引数配列（LaunchParams.args）を組み立てる。
// - config が無い場合は固定エビ無し（空配列）として扱い、起動は継続する（任意機能）。

import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { isAbsolute, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import type { AgentKind } from "../shared/protocol.ts";
import type { LaunchParams } from "./agent.ts";

/** claude --permission-mode が受け付ける値（`claude --help` で確認済み）。 */
export const PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * 全エビ共通の permission-mode 既定。
 * 無人オーケストレーション（master が engineer を回す）向けに auto モードを採る（オーナー指定）。
 * config 側で個別に上書き可能。
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

/**
 * engineer エビ（master が spawn する、無人で働く作業セッション）の permission-mode。
 * 確認待ちで止まらないよう bypassPermissions。安全性は worktree/cwd 隔離＋engineer 役割
 * プロンプト（破壊的操作・push・外部送信はしない）で担保。
 * master/supervisor/UI からの素の dynamic spawn は DEFAULT_PERMISSION_MODE(auto) のまま。
 */
export const ENGINEER_PERMISSION_MODE: PermissionMode = "bypassPermissions";

/** ebi-team.config.json の固定エビ 1 件分の生スキーマ（パース直後・未検証）。 */
interface RawFixedEbi {
  id?: unknown;
  kind?: unknown;
  cwd?: unknown;
  model?: unknown;
  permissionMode?: unknown;
  args?: unknown;
  appendSystemPrompt?: unknown;
  /** テスト用にバイナリを差し替えたい場合（既定は claude / EBI_COMMAND）。 */
  command?: unknown;
  /**
   * notification（mailbox 購読）経路で受信するか（既定 true）。
   * false にすると「受信を PTY 注入に固定」する（外部チャンネル待機セッションで、
   * 自セッションに ebi-control channel を登録しない＝notification が黙って捨てられる場合に使う）。
   */
  notifySubscribe?: unknown;
}

interface RawConfig {
  fixedEbi?: unknown;
  /** カスタム役割（{ [id]: RoleDef }）。バリデーション/マージは roles.ts の registerCustomRoles が行う。 */
  roles?: unknown;
  /**
   * 起動ゲート自動応答を許可する dev channel 値の追加許可リスト（正確値・完全一致）。
   * 組込み（server:ebi-control）に足す形。ワイルドカード・部分一致は不可。
   */
  devChannelsAllowlist?: unknown;
}

/**
 * config ファイルを読み JSON パースするだけの共通ヘルパー。
 * - ファイルが無ければ null（呼び出し側で「機能 OFF」として扱う）。
 * - JSON 不正は throw（呼び出し側で警告ログにして起動継続するか判断）。
 * loadFixedEbi / loadRawCustomRoles の双方から使う（同じファイルをそれぞれ独立に読む。
 * 起動時 1 回だけなので I/O コストは無視できる）。
 */
async function readRawConfig(configPath: string): Promise<RawConfig | null> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as RawConfig;
  } catch (err) {
    throw new Error(`${configPath} の JSON パースに失敗: ${(err as Error).message}`);
  }
}

/**
 * ebi-team.config.json の top-level "roles" を生のまま返す（型・意味検証は roles.ts の
 * registerCustomRoles が行う。ここではファイル読み込み/JSON パースのみ担当する）。
 * - ファイルが無い、または roles キーが無ければ undefined。
 */
export async function loadRawCustomRoles(configPath: string): Promise<unknown> {
  const parsed = await readRawConfig(configPath);
  return parsed?.roles;
}

/**
 * ebi-team.config.json の top-level "devChannelsAllowlist"（起動ゲート自動応答を許可する
 * dev channel 値の追加許可リスト・正確値）を読み、文字列配列として返す。
 * - ファイルが無い／キーが無ければ空配列（追加なし）。
 * - 配列でない／文字列以外の要素を含む場合は throw（呼び出し側で警告ログにして起動継続する想定）。
 * 組込みの BASE_ALLOWED_DEV_CHANNELS への「追加」であり、置換ではない（index.ts でマージ）。
 */
export async function loadDevChannelsAllowlist(configPath: string): Promise<string[]> {
  const parsed = await readRawConfig(configPath);
  const raw = parsed?.devChannelsAllowlist;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${configPath} の devChannelsAllowlist は文字列配列である必要があります`);
  }
  for (const v of raw) {
    if (typeof v !== "string") {
      throw new Error(`${configPath} の devChannelsAllowlist の要素はすべて文字列である必要があります`);
    }
  }
  return raw as string[];
}

/** 正規化済みの固定エビ定義。サーバが spawn にそのまま使える形。 */
export interface FixedEbiSpec {
  id: string;
  kind: AgentKind;
  /** 起動に使う実パラメータ（command/args/cwd/model 展開済み）。 */
  launch: LaunchParams;
  /**
   * notification（mailbox 購読）経路で受信するか（既定 true）。
   * false のとき送信側は購読確立を待たず PTY 注入で届ける（受信 PTY 固定）。
   */
  notifySubscribe: boolean;
}

/** 固定エビをビルドするための既定値（サーバの spawnConfig から渡す）。 */
export interface ConfigDefaults {
  /** command 未指定の固定エビに使う既定コマンド（EBI_COMMAND 由来）。 */
  command: string;
}

/**
 * claude 起動引数を組み立てる共通ヘルパー。
 * 固定エビ（config 経由）と動的 engineer エビ（制御API 経由）の双方で使う。
 *
 * 起動引数の組み立て順:
 *   [--model M]? [--permission-mode P]? [--append-system-prompt S]? ...任意 args
 *
 * テスト等で command を bash 等に差し替えた場合は claude 固有フラグを付けない
 * （bash が解釈できず即終了→crashloop になるのを防ぐ）。
 */
export function buildClaudeArgs(opts: {
  command: string;
  model?: string | null;
  permissionMode?: PermissionMode;
  appendSystemPrompt?: string | null;
  extraArgs?: string[];
}): string[] {
  const { command, model, permissionMode, appendSystemPrompt, extraArgs = [] } = opts;
  const isClaude = command === "claude" || command.endsWith("/claude");
  const args: string[] = [];
  if (isClaude) {
    if (model) args.push("--model", model);
    if (permissionMode) args.push("--permission-mode", permissionMode);
    if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);
  }
  args.push(...extraArgs);
  return args;
}

/** permissionMode 文字列を検証して返す。不正なら throw。 */
export function validatePermissionMode(value: string): PermissionMode {
  if (!(PERMISSION_MODES as readonly string[]).includes(value)) {
    throw new Error(
      `permissionMode が不正です: ${value}（許容: ${PERMISSION_MODES.join(", ")}）`,
    );
  }
  return value as PermissionMode;
}

/**
 * `$HOME` / `${HOME}` / `~` を展開する。未知の変数はそのまま残す。
 * 加えて `$EBI_TEAM` を ebi-team のルート（= config のあるディレクトリ）に展開する。
 * これにより config.json の args（例 `--mcp-config $EBI_TEAM/.ebi-team/master-control.mcp.json`）を
 * machine 非依存・絶対パス化して書ける（master の cwd が ebi-team 配下でなくても破綻しない）。
 */
function expandEnv(input: string, configDir?: string): string {
  let s = input;
  if (s === "~" || s.startsWith("~/")) {
    s = homedir() + s.slice(1);
  }
  if (configDir) {
    s = s.replace(/\$\{?EBI_TEAM\}?/g, configDir);
  }
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) => process.env[name] ?? m);
  s = s.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name: string) => process.env[name] ?? m);
  return s;
}

/** cwd を環境変数展開＋config 基準で絶対パス化し、ディレクトリ存在を検証する。 */
function resolveCwd(rawCwd: string, configDir: string, id: string): string {
  const expanded = expandEnv(rawCwd, configDir);
  const abs = isAbsolute(expanded) ? expanded : resolve(configDir, expanded);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    throw new Error(`固定エビ "${id}" の cwd が存在しません: ${abs}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`固定エビ "${id}" の cwd がディレクトリではありません: ${abs}`);
  }
  return abs;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** raw な値を boolean として検証する。型不正は明確な Error を throw する。 */
function asBoolean(v: unknown, id: string): boolean {
  if (typeof v !== "boolean") {
    throw new Error(`固定エビ "${id}" の notifySubscribe は真偽値である必要があります`);
  }
  return v;
}

/** raw な args 配列を文字列配列へ正規化する（非文字列要素は除外）。 */
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * 1 件の生定義を検証・正規化して FixedEbiSpec を返す。
 * 起動引数（args）の組み立て順:
 *   [--model M]? [--permission-mode P]? [--append-system-prompt S]? ...任意 args
 */
function normalizeOne(raw: RawFixedEbi, configDir: string, defaults: ConfigDefaults): FixedEbiSpec {
  const id = asString(raw.id);
  if (!id) throw new Error("固定エビの id（文字列）が必要です");

  const kindRaw = asString(raw.kind) ?? "dynamic";
  if (kindRaw !== "master" && kindRaw !== "supervisor" && kindRaw !== "dynamic") {
    throw new Error(`固定エビ "${id}" の kind が不正です: ${kindRaw}`);
  }
  const kind = kindRaw as AgentKind;

  const cwdRaw = asString(raw.cwd);
  if (!cwdRaw) throw new Error(`固定エビ "${id}" の cwd（文字列）が必要です`);
  const cwd = resolveCwd(cwdRaw, configDir, id);

  const model = asString(raw.model) ?? null;

  const permissionRaw = asString(raw.permissionMode);
  const permissionMode: PermissionMode = permissionRaw
    ? (() => {
        try {
          return validatePermissionMode(permissionRaw);
        } catch (err) {
          throw new Error(`固定エビ "${id}" の ${(err as Error).message}`);
        }
      })()
    : DEFAULT_PERMISSION_MODE;

  const appendSystemPrompt = asString(raw.appendSystemPrompt);
  // args は $EBI_TEAM / $HOME / ~ を展開する（--mcp-config の絶対パス指定を machine 非依存に）。
  const extraArgs = asStringArray(raw.args).map((a) => expandEnv(a, configDir));
  const command = asString(raw.command) ?? defaults.command;

  const args = buildClaudeArgs({ command, model, permissionMode, appendSystemPrompt, extraArgs });

  // notifySubscribe（既定 true）。false は「受信を PTY 注入に固定」する印。
  const notifySubscribe = raw.notifySubscribe === undefined ? true : asBoolean(raw.notifySubscribe, id);

  return { id, kind, launch: { command, args, cwd, model }, notifySubscribe };
}

/**
 * config ファイルを読み込み、固定エビ定義を正規化して返す。
 * - ファイルが無ければ空配列（固定エビ無し）。
 * - JSON 不正・スキーマ不正は throw（呼び出し側で警告ログにして起動継続するか判断）。
 */
export async function loadFixedEbi(
  configPath: string,
  defaults: ConfigDefaults,
): Promise<FixedEbiSpec[]> {
  const parsed = await readRawConfig(configPath);
  if (parsed === null) {
    // ファイル無し＝固定エビ機能を使わない。エラーにしない。
    return [];
  }

  const list = parsed.fixedEbi;
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    throw new Error(`${configPath} の fixedEbi は配列である必要があります`);
  }

  const configDir = dirname(configPath);
  const specs = list.map((raw) => normalizeOne(raw as RawFixedEbi, configDir, defaults));

  // id 重複チェック。
  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.id)) throw new Error(`固定エビの id が重複しています: ${s.id}`);
    seen.add(s.id);
  }
  return specs;
}
