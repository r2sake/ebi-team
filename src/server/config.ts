// 固定エビ（master/supervisor）の宣言的 config（ebi-team.config.json）のロード・正規化。
//
// 設計方針:
// - ルートの `ebi-team.config.json` を読み、固定エビ定義を検証・正規化して返す。
// - cwd は `$HOME` 等の環境変数展開と相対パス解決（config 基準）を行い、存在チェックする。
// - command / args / model / permissionMode / appendSystemPrompt から
//   node-pty に渡す実引数配列（LaunchParams.args）を組み立てる。
// - config が無い場合は固定エビ無し（空配列）として扱い、起動は継続する（任意機能）。

import { readFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import type { AgentKind } from "../shared/protocol.ts";
import type { LaunchParams } from "./agent.ts";
import {
  buildLaunchArgs,
  getBackend,
  isImplementedBackendId,
  resolveBackend,
  backendIdError,
  DEFAULT_BACKEND_ID,
  IMPLEMENTED_BACKEND_IDS,
  PERMISSION_MODES,
  type BackendId,
  type PermissionMode,
} from "./backends/index.ts";
// master 頭脳（MasterBrain）の値域。brain.ts は純粋な型/定数のみ（プロセスを起動しない）なので
// config から直接 import してよい（master/index.ts 経由にすると spawn 実装まで引き込む）。
import {
  DEFAULT_MASTER_BRAIN_ID,
  MASTER_BRAIN_IDS,
  type MasterBrainId,
} from "./master/brain.ts";
// 推論努力度（--effort）の解決は effort.ts が SoT（純関数・I/O なし）。
import {
  EMPTY_EFFORT_BY_MODEL,
  describeEffort,
  effortArgs,
  normalizeEffortByModel,
  resolveEffort,
  type Effort,
  type EffortByModel,
} from "./effort.ts";

// permission-mode の語彙は backends/types.ts（バックエンド非依存の抽象語彙）が SoT。
// 既存の import 元（roles.ts / index.ts / control-server.ts 等）を壊さないよう再エクスポートする。
export { PERMISSION_MODES };
export type { PermissionMode };

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
  /**
   * appendSystemPrompt の本文をファイルから読む場合のパス（appendSystemPrompt と同時指定は不可）。
   * cwd と同じく $EBI_TEAM / $HOME / ~ を展開し、相対パスは config のあるディレクトリ基準。
   * 中身はそのまま（置換・trim なし）使う。読めなければ cwd 不在と同じく起動時エラー。
   */
  appendSystemPromptFile?: unknown;
  /** テスト用にバイナリを差し替えたい場合（既定は claude / EBI_COMMAND）。 */
  command?: unknown;
  /**
   * この固定エビを動かすバックエンド id（claude / codex / gemini）。
   * 未指定なら従来どおり command から解決する（挙動不変）。
   * 指定すると (a) command 未指定時の既定バイナリ、(b) 起動引数の方言、(c) launch.backend の
   * 3 つがそのバックエンドに揃う（command と backend を別々に書いてズレる事故を作らない）。
   */
  backend?: unknown;
  /**
   * notification（mailbox 購読）経路で受信するか（既定 true）。
   * false にすると「受信を PTY 注入に固定」する（外部チャンネル待機セッションで、
   * 自セッションに ebi-control channel を登録しない＝notification が黙って捨てられる場合に使う）。
   */
  notifySubscribe?: unknown;
  /**
   * master の UI 方式（"terminal" | "chat"。既定 "terminal" ＝現行の PTY 経路）。
   * "chat" のとき PTY を一切起動せず MasterSession（ヘッドレス頭脳）で動かす。
   * 設計書 docs/design/master-chat-ui-2026-09-05.md §6.1。env EBI_MASTER_UI で上書きできる。
   */
  ui?: unknown;
  /**
   * master の頭脳（MasterBrain）id。未指定は "claude"（ボス裁定 Q-1: 既定は claude）。
   * ui:"chat" のときだけ意味を持つ。
   */
  brain?: unknown;
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
  /** サーバ既定のバックエンド id（env EBI_BACKEND より優先）。検証は loadBackendSettings。 */
  defaultBackend?: unknown;
  /** バックエンド別の既定（command / defaultModel）。検証は loadBackendSettings。 */
  backends?: unknown;
  /**
   * モデル→推論努力度（claude の `--effort`）の既定表（{ モデルパターン: low|medium|high }）。
   * 検証・引き当ては effort.ts（normalizeEffortByModel / effortForModel）が SoT。
   */
  effortByModel?: unknown;
  /**
   * セキュリティモード（"standard" | "secure"）。env EBI_SECURITY_MODE が優先。
   * 検証は security.ts の resolveSecurityMode。再起動でのみ切り替わる。
   */
  securityMode?: unknown;
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
 * ebi-team.config.json の top-level "securityMode" を生のまま返す（検証は security.ts）。
 * ファイルが無い／キーが無ければ undefined。
 */
export function loadRawSecurityModeSync(configPath: string): unknown {
  // サーバのモジュール評価時に 1 回だけ同期で読む（モードを定数にして途中で変えないため）。
  // JSON 不正は throw（呼び出し側が安全側に倒す）。
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return undefined;
  }
  return (JSON.parse(text) as RawConfig)?.securityMode;
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

// ===== バックエンド既定（PR-E: top-level "defaultBackend" / "backends"） =====

/** バックエンド 1 件分の既定（ebi-team.config.json の backends[<id>]）。 */
export interface BackendConfigEntry {
  /** 起動バイナリ（未指定なら backend の defaultCommand）。 */
  command?: string;
  /** そのバックエンドの既定モデル（未指定なら env EBI_<ID>_MODEL → CLI 既定）。 */
  defaultModel?: string;
}

/** config 由来のバックエンド既定（サーバ既定 backend と backend 別の設定）。 */
export interface BackendSettings {
  /** config.defaultBackend（未指定なら null → env EBI_BACKEND → claude）。 */
  defaultBackend: BackendId | null;
  /** backend 別の既定。未定義の backend は空オブジェクト相当（参照側は ?. で読む）。 */
  backends: Partial<Record<BackendId, BackendConfigEntry>>;
}

/** バックエンド既定が何も無いときの値（config 無し・キー無し）。 */
export const EMPTY_BACKEND_SETTINGS: BackendSettings = { defaultBackend: null, backends: {} };

/**
 * top-level "defaultBackend" / "backends" を検証・正規化する純関数（I/O 無し＝単体テスト対象）。
 * - 未指定は「既定なし」。未実装/未知の backend id は throw（黙って claude に落とさない）。
 * - backends のキーは実装済み backend id のみ許容。値は { command?, defaultModel? }。
 */
export function normalizeBackendSettings(raw: {
  defaultBackend?: unknown;
  backends?: unknown;
}): BackendSettings {
  let defaultBackend: BackendId | null = null;
  if (raw.defaultBackend !== undefined && raw.defaultBackend !== null) {
    if (typeof raw.defaultBackend !== "string") {
      throw new Error("defaultBackend は文字列である必要があります");
    }
    if (!isImplementedBackendId(raw.defaultBackend)) throw backendIdError(raw.defaultBackend);
    defaultBackend = raw.defaultBackend;
  }

  const backends: Partial<Record<BackendId, BackendConfigEntry>> = {};
  if (raw.backends !== undefined && raw.backends !== null) {
    if (typeof raw.backends !== "object" || Array.isArray(raw.backends)) {
      throw new Error("backends はオブジェクト（{ backendId: 定義 }）である必要があります");
    }
    for (const [id, def] of Object.entries(raw.backends as Record<string, unknown>)) {
      if (!isImplementedBackendId(id)) {
        throw new Error(
          `backends のキーが不正です: ${id}（許容: ${IMPLEMENTED_BACKEND_IDS.join(", ")}）`,
        );
      }
      if (def === null || typeof def !== "object" || Array.isArray(def)) {
        throw new Error(`backends."${id}" の定義はオブジェクトである必要があります`);
      }
      const d = def as Record<string, unknown>;
      const entry: BackendConfigEntry = {};
      for (const field of ["command", "defaultModel"] as const) {
        const v = d[field];
        if (v === undefined) continue;
        if (typeof v !== "string") {
          throw new Error(`backends."${id}" の ${field} は文字列である必要があります`);
        }
        entry[field] = v;
      }
      backends[id] = entry;
    }
  }
  return { defaultBackend, backends };
}

/**
 * ebi-team.config.json の top-level "defaultBackend" / "backends" を読み、正規化して返す。
 * - ファイルが無ければ EMPTY_BACKEND_SETTINGS（既定なし＝従来どおり env → claude）。
 * - 検証失敗は throw（呼び出し側で警告ログにして起動継続する想定）。
 */
export async function loadBackendSettings(configPath: string): Promise<BackendSettings> {
  const parsed = await readRawConfig(configPath);
  if (parsed === null) return EMPTY_BACKEND_SETTINGS;
  try {
    return normalizeBackendSettings(parsed);
  } catch (err) {
    throw new Error(`${configPath} の ${(err as Error).message}`);
  }
}

// ===== 推論努力度の既定（top-level "effortByModel"） =====

/**
 * ebi-team.config.json の top-level "effortByModel" を読み、正規化して返す。
 * - ファイルが無い／キーが無ければ空の表（＝従来どおり CLI 既定 effort に任せる）。
 * - 検証失敗は throw（呼び出し側で警告ログにして起動継続する想定）。
 */
export async function loadEffortByModel(configPath: string): Promise<EffortByModel> {
  const parsed = await readRawConfig(configPath);
  if (parsed === null) return EMPTY_EFFORT_BY_MODEL;
  try {
    return normalizeEffortByModel(parsed.effortByModel);
  } catch (err) {
    throw new Error(`${configPath} の ${(err as Error).message}`);
  }
}

/** master の UI 方式。既定は terminal（現行の PTY 経路と完全に同一）。 */
export type MasterUiMode = "terminal" | "chat";

export const MASTER_UI_MODES: readonly MasterUiMode[] = ["terminal", "chat"];

/** 正規化済みの固定エビ定義。サーバが spawn にそのまま使える形。 */
export interface FixedEbiSpec {
  id: string;
  kind: AgentKind;
  /** 起動に使う実パラメータ（command/args/cwd/model 展開済み）。 */
  launch: LaunchParams;
  /**
   * UI 方式（master 専用・既定 "terminal"）。
   * "chat" のときサーバは PTY を起動せず MasterSession を作る（設計書 §6.1）。
   */
  ui: MasterUiMode;
  /** master 頭脳の id（ui:"chat" のときのみ使用。既定 "claude"）。 */
  brain: MasterBrainId;
  /**
   * 抽象 permissionMode（launch.args にも焼かれているが、chat モードは args を通さず
   * MasterBrain へ直接渡すため、正規化済みの値をここにも持つ）。
   */
  permissionMode: PermissionMode;
  /**
   * config の args（$EBI_TEAM 等を展開済み・**方言フラグを付ける前**の生の追加引数）。
   * ただし effortByModel が効いた場合は解決済みの `--effort <値>` がここに含まれる
   * （claude 方言のフラグだが、PTY 経路と master チャット経路の両方が extraArgs を
   * そのまま末尾へ流すため、1 か所で揃えるのが最も漏れが無い）。
   */
  extraArgs: string[];
  /**
   * この固定エビに実際に付与した推論努力度（`--effort`）。
   * null なら付与していない（args に明示があった／表に当たらなかった＝CLI 既定）。
   */
  effort: Effort | null;
  /**
   * notification（mailbox 購読）経路で受信するか（既定 true）。
   * false のとき送信側は購読確立を待たず PTY 注入で届ける（受信 PTY 固定）。
   */
  notifySubscribe: boolean;
}

/**
 * ワンショット要約エンジン（ask_supervisor / WS summarize）の起動設定。
 * 常駐 supervisor 固定エビの backend / model をそのまま流用する
 *（config 1 箇所を書き換えれば「常駐セッション」と「要約エンジン」が揃って切り替わる）。
 */
export interface SupervisorEngineConfig {
  backend: BackendId;
  /** 固定エビ config の model（未指定なら null → 各エンジンの既定モデル）。 */
  model: string | null;
}

/**
 * 固定エビ定義から要約エンジンの設定を取り出す純関数。
 * kind === "supervisor" の最初の 1 件を使う。無ければ null（＝従来どおり claude/haiku の既定）。
 */
export function supervisorEngineFrom(specs: FixedEbiSpec[]): SupervisorEngineConfig | null {
  const spec = specs.find((s) => s.kind === "supervisor");
  if (!spec) return null;
  return { backend: spec.launch.backend ?? DEFAULT_BACKEND_ID, model: spec.launch.model };
}

/** 固定エビをビルドするための既定値（サーバの spawnConfig から渡す）。 */
export interface ConfigDefaults {
  /** command 未指定の固定エビに使う既定コマンド（EBI_COMMAND 由来）。 */
  command: string;
  /**
   * サーバ既定のバックエンド id（config.defaultBackend / env EBI_BACKEND 解決済み）。
   * 未指定なら "claude"。PR1 時点では常に "claude"。
   */
  backend?: BackendId;
}

/**
 * 制御MCP ブリッジ無しの起動引数を組み立てる共通ヘルパー（固定エビ config 経由の起動）。
 *
 * 起動引数の組み立て順:
 *   [--model M]? [--permission-mode P]? [--append-system-prompt S]? ...任意 args
 *
 * 実体は backends/index.ts の buildLaunchArgs（バックエンド抽象の唯一の入口）。
 * command に一致するバックエンドが無い場合（テストで bash 等に差し替えた場合）は
 * 固有フラグを付けない（bash が解釈できず即終了→crashloop になるのを防ぐ）。
 *
 * 注: 固定エビは `--mcp-config` を config の args に直書きする運用のため、ここでは
 * mcpConfigPath を渡さない（args はそのまま extraArgs として末尾に付く＝従来どおり）。
 */
export function buildClaudeArgs(opts: {
  command: string;
  /**
   * バックエンドの明示指定（config の fixedEbi[].backend 由来）。
   * 指定された場合は command ではなくこちらで方言を決める（command を残したまま
   * backend だけ差し替えたケースでも、引数が backend 側に揃う）。
   */
  backendId?: BackendId | null;
  model?: string | null;
  permissionMode?: PermissionMode;
  appendSystemPrompt?: string | null;
  extraArgs?: string[];
}): string[] {
  const input = {
    model: opts.model ?? null,
    permissionMode: opts.permissionMode ?? null,
    systemPrompt: opts.appendSystemPrompt ?? null,
    mcpConfigPath: null,
    notifyMode: false,
    extraArgs: opts.extraArgs ?? [],
  };
  if (opts.backendId) return getBackend(opts.backendId).buildArgs(input);
  return buildLaunchArgs(opts.command, input);
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
 * appendSystemPrompt（直書き）/ appendSystemPromptFile（ファイル参照）から本文を決める。
 * 長い指示文を別ファイルの 1 か所で管理し、config へ写し直す手間とズレを無くすための口。
 * 両方指定は曖昧なので明示エラー。ファイルが読めないときは cwd 不在と同じく throw し、
 * その固定エビ 1 体だけを起動対象から外す（指示文抜きで起動させない＝境界エビの安全指示が
 * 黙って欠ける事故を作らない。ほかの固定エビは loadFixedEbiReport が起こす）。
 */
function resolveAppendSystemPrompt(raw: RawFixedEbi, configDir: string, id: string): string | undefined {
  const inline = asString(raw.appendSystemPrompt);
  const fileRaw = asString(raw.appendSystemPromptFile);
  if (fileRaw === undefined) return inline;
  if (inline !== undefined) {
    throw new Error(`固定エビ "${id}" は appendSystemPrompt と appendSystemPromptFile を同時に指定できません`);
  }
  const expanded = expandEnv(fileRaw, configDir);
  const abs = isAbsolute(expanded) ? expanded : resolve(configDir, expanded);
  try {
    return readFileSync(abs, "utf8");
  } catch (err) {
    throw new Error(`固定エビ "${id}" の appendSystemPromptFile を読めません: ${abs}（${(err as Error).message}）`);
  }
}

/**
 * 1 件の生定義を検証・正規化して FixedEbiSpec を返す。
 * 起動引数（args）の組み立て順:
 *   [--model M]? [--permission-mode P]? [--append-system-prompt S]? ...任意 args
 */
function normalizeOne(
  raw: RawFixedEbi,
  configDir: string,
  defaults: ConfigDefaults,
  effortByModel: EffortByModel = EMPTY_EFFORT_BY_MODEL,
): FixedEbiSpec {
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

  // ui（master 専用・既定 terminal）。値域外は起動時に落として気づけるよう明示エラーにする。
  const uiRaw = asString(raw.ui);
  if (uiRaw !== undefined && !MASTER_UI_MODES.includes(uiRaw as MasterUiMode)) {
    throw new Error(
      `固定エビ "${id}" の ui が不正です: ${uiRaw}（許容: ${MASTER_UI_MODES.join(", ")}）`,
    );
  }
  const ui = (uiRaw ?? "terminal") as MasterUiMode;
  if (ui === "chat" && kind !== "master") {
    throw new Error(`固定エビ "${id}" の ui:"chat" は kind:"master" のみで使えます`);
  }

  // brain（master 頭脳・既定 claude）。未実装 id（gemini/agy）は起動時に明示エラーになる。
  const brainRaw = asString(raw.brain);
  if (brainRaw !== undefined && !MASTER_BRAIN_IDS.includes(brainRaw as MasterBrainId)) {
    throw new Error(
      `固定エビ "${id}" の brain が不正です: ${brainRaw}（許容: ${MASTER_BRAIN_IDS.join(", ")}）`,
    );
  }
  const brain = (brainRaw ?? DEFAULT_MASTER_BRAIN_ID) as MasterBrainId;

  const appendSystemPrompt = resolveAppendSystemPrompt(raw, configDir, id);
  // args は $EBI_TEAM / $HOME / ~ を展開する（--mcp-config の絶対パス指定を machine 非依存に）。
  const extraArgs = asStringArray(raw.args).map((a) => expandEnv(a, configDir));

  // backend の明示指定（任意）。未指定なら従来どおり command から解決する＝挙動不変。
  const backendRaw = asString(raw.backend);
  let backendId: BackendId | null = null;
  if (backendRaw !== undefined) {
    if (!isImplementedBackendId(backendRaw)) {
      throw new Error(`固定エビ "${id}" の ${backendIdError(backendRaw).message}`);
    }
    backendId = backendRaw;
  }
  // backend を書いたなら command の既定もそのバックエンドのバイナリにする
  //（"backend": "gemini" だけ書いて command を書き忘れ、claude が起動する事故を防ぐ）。
  const command =
    asString(raw.command) ?? (backendId ? getBackend(backendId).defaultCommand : defaults.command);

  // 実際に使うバックエンド（明示 > command からの解決 > サーバ既定）。
  const resolvedBackendId: BackendId =
    backendId ?? resolveBackend(command)?.id ?? defaults.backend ?? DEFAULT_BACKEND_ID;

  // 推論努力度（--effort）。claude 方言のフラグなので、**その固定エビが実際に claude で動く
  // ときだけ**適用する（backend 明示 claude / command が claude に解決できる場合）。
  // どの backend にも一致しない command（bash 等のスタブ起動）には付けない＝従来どおり。
  const isClaudeLaunch =
    backendId === DEFAULT_BACKEND_ID ||
    (backendId === null && resolveBackend(command)?.id === DEFAULT_BACKEND_ID);
  const resolvedEffort = isClaudeLaunch
    ? resolveEffort({ model, table: effortByModel, existingArgs: extraArgs })
    : { effort: null, source: null };
  // args 側に明示があればそれを優先する（resolveEffort が effort:null を返す）＝二重付与しない。
  const extraArgsWithEffort = [...extraArgs, ...effortArgs(resolvedEffort)];

  const args = buildClaudeArgs({
    command,
    backendId,
    model,
    permissionMode,
    appendSystemPrompt,
    extraArgs: extraArgsWithEffort,
  });

  const effortNote = describeEffort(resolvedEffort);
  if (effortNote) console.log(`[ebi-team] 固定エビ ${id}: ${effortNote}`);

  // notifySubscribe（既定 true）。false は「受信を PTY 注入に固定」する印。
  const notifySubscribe = raw.notifySubscribe === undefined ? true : asBoolean(raw.notifySubscribe, id);

  return {
    id,
    kind,
    ui,
    brain,
    permissionMode,
    extraArgs: extraArgsWithEffort,
    effort: resolvedEffort.effort,
    // 固定エビの backend は **明示指定 > command から解決**（サーバ既定を波及させない）。
    // 理由: 設計上 master は常に claude（統括系を落とさない）で、EBI_BACKEND=codex のような
    // サーバ既定をそのまま master に付けると、claude/bash のプロセスに codex の性質
    //（readyPattern 待ち・プロセスグループ kill）が乗って ready 判定が壊れる。
    // command がどの backend にも一致しないスタブ起動（bash 等）は既定（claude）の性質を使う
    // ＝ 従来どおり（PR-D 時点で挙動不変）。
    launch: {
      command,
      args,
      cwd,
      model,
      backend: resolvedBackendId,
      // 役割プロンプトは args だけでは足りない。gemini は `--append-system-prompt` 相当を
      // 持たず per-エビ GEMINI.md（backend.buildEnv 経由）で注入するため、生の本文を
      // launch にも載せて agent.ts → backend.buildEnv へ渡す。
      // claude / codex の buildEnv はこの値を見ないので、従来経路は挙動不変。
      systemPrompt: appendSystemPrompt ?? null,
    },
    notifySubscribe,
  };
}

/** 読み込みで外した固定エビ 1 体ぶんの記録（id が読めないときは "#<配列の位置>"）。 */
export interface SkippedFixedEbi {
  id: string;
  reason: string;
}

/**
 * config ファイルを読み込み、固定エビ定義を正規化して返す（1 体ずつ fail-soft）。
 * - ファイルが無ければ空（固定エビ無し）。
 * - JSON 不正・fixedEbi が配列でない・effortByModel 不正は全体の問題なので throw。
 * - 1 体ぶんの検証・正規化エラー（cwd 不在・appendSystemPromptFile が読めない・kind 不正 等）は
 *   その 1 体だけを specs から外し、skipped に id と理由を積む（ほかの固定エビは起こす）。
 * - id 重複は後から出た方を外す（先に書かれた定義を正とする）。
 */
export async function loadFixedEbiReport(
  configPath: string,
  defaults: ConfigDefaults,
): Promise<{ specs: FixedEbiSpec[]; skipped: SkippedFixedEbi[] }> {
  const parsed = await readRawConfig(configPath);
  if (parsed === null) {
    // ファイル無し＝固定エビ機能を使わない。エラーにしない。
    return { specs: [], skipped: [] };
  }

  const list = parsed.fixedEbi;
  if (list === undefined) return { specs: [], skipped: [] };
  if (!Array.isArray(list)) {
    throw new Error(`${configPath} の fixedEbi は配列である必要があります`);
  }

  const configDir = dirname(configPath);
  const effortByModel = normalizeEffortByModel(parsed.effortByModel);
  const specs: FixedEbiSpec[] = [];
  const skipped: SkippedFixedEbi[] = [];
  const seen = new Set<string>();
  list.forEach((raw, i) => {
    const rawId = asString((raw as RawFixedEbi | null)?.id);
    const label = rawId || `#${i}`;
    try {
      const spec = normalizeOne(raw as RawFixedEbi, configDir, defaults, effortByModel);
      if (seen.has(spec.id)) throw new Error(`固定エビの id が重複しています: ${spec.id}`);
      seen.add(spec.id);
      specs.push(spec);
    } catch (err) {
      skipped.push({ id: label, reason: (err as Error).message });
    }
  });
  return { specs, skipped };
}

/**
 * 固定エビ定義を厳格に読む（1 体でも外れる定義があれば、その理由で throw）。
 * サーバの起動経路は loadFixedEbiReport を使う（1 体の不備で全体を止めない）。
 * こちらは定義の検証をまとめて確かめたいとき用。
 */
export async function loadFixedEbi(
  configPath: string,
  defaults: ConfigDefaults,
): Promise<FixedEbiSpec[]> {
  const { specs, skipped } = await loadFixedEbiReport(configPath, defaults);
  if (skipped.length > 0) throw new Error(skipped[0].reason);
  return specs;
}
