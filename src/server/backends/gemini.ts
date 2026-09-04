// Gemini CLI バックエンド実装（PR-C）。
//
// PoC（docs/poc/gemini-poc-2026-09-04.md・gemini-cli 0.58.0 実測）で確定した事項を実装に落とす:
// - PTY 駆動で成立する（`--experimental-acp` は不要。注入 20/20・alt-screen へ入らない・
//   待機中は完全無出力なので idle 判定もサーバ既定 900ms のままでよい）。
// - per-エビの MCP / ゲート無効化は `GEMINI_CLI_SYSTEM_SETTINGS_PATH`（system スコープ＝
//   マージ最終段＝最優先）で渡す。**`~/.gemini/settings.json` と `~/.gemini/trustedFolders.json`
//   は絶対に書き換えない**（ボスの共有環境を汚さない）。
// - モデルは `gemini-2.5-flash` を明示指定する（`gemini-flash-latest` 等の alias は
//   Code Assist 経路で 404 になる）。
// - cwd は必ずエビの worktree ルート（サブディレクトリで起動すると、yolo でも
//   「workspace 外ファイルの読み取り確認」ダイアログが出て注入が食われる）。
// - kill はプロセスグループごと（gemini は子 node を再 exec するため PTY リーダの kill だけでは
//   子と配下の stdio MCP が孤児として残る）。実際の分岐は agent.ts（killProcessGroup トレイト）。
//
// 課金枠: ログイン中の Workspace アカウントでは free-tier が存在せず、
// **GCP プロジェクト紐付きの Gemini Code Assist Standard 枠**を消費する（ボス裁定 2026-09-05 で
// 会社 GCP 枠の使用が許可済み）。したがって `GOOGLE_CLOUD_PROJECT` は **deny せず継承する**
// （落とすと ProjectIdRequiredError で起動すらできない）。deny するのは API キー課金・
// 別認証経路の 5 個のみ（profiles.ts の GEMINI_TRAITS が SoT）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EBI_CONTROL_MCP_NAME } from "./claude.ts";
import { toGeminiSystemSettings, type GeminiSystemSettings } from "./mcpSpec.ts";
import { GEMINI_TRAITS } from "./profiles.ts";
import type {
  BackendEnvInput,
  BackendLaunchInput,
  ControlMcpSpec,
  EbiBackend,
  PermissionMode,
} from "./types.ts";

/** PoC で検証済みの gemini-cli バージョン（profiles.ts の preflight と同値・表示用）。 */
export const GEMINI_VERIFIED_VERSION = "0.58.0";

/**
 * 既定モデル。**明示 ID 必須**（PoC 実測: `gemini-flash-latest` / `gemini-2.0-flash` /
 * `gemini-3-pro-preview` はいずれも Code Assist 経路で 404 NOT_FOUND）。
 * 重い読解・設計タスクだけ GEMINI_HEAVY_MODEL を明示指定する運用。
 */
export const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

/** 重い読解・設計用（枠消費が大きいので既定にはしない）。 */
export const GEMINI_HEAVY_MODEL = "gemini-2.5-pro";

/** system settings を差し込む env キー。 */
export const GEMINI_SETTINGS_ENV = "GEMINI_CLI_SYSTEM_SETTINGS_PATH";

/** per-エビ runtime（settings.json / 役割 GEMINI.md）の置き場。env で上書き可。 */
export const GEMINI_RUNTIME_DIR_ENV = "EBI_GEMINI_RUNTIME_DIR";

const MODEL_FLAG = "-m";
const APPROVAL_MODE_FLAG = "--approval-mode";
const ALLOWED_MCP_FLAG = "--allowed-mcp-server-names";

/** gemini の承認モード（`--approval-mode` の値域）。 */
export type GeminiApprovalMode = "default" | "auto_edit" | "yolo";

/**
 * 抽象 permissionMode → gemini `--approval-mode` の写像。
 *
 * 注意（設計上の割り切り）: **無人運用では yolo が実質必須**。gemini の承認系統は
 * 「ファイル書き込み」だけでなく **MCP ツール呼び出し・workspace 外ファイルの読み取り**にも
 * ダイアログを出し、それが出た回は PTY 注入がダイアログに食われる（PoC で 9/10 に劣化）。
 * よって reply_to_master を確実に届けるには yolo が要る。
 * **書き込み抑止は承認モードでは担保しない**。担保するのは
 *   (1) cwd をエビ専用 worktree に閉じること（workspace 外は触らせない）
 *   (2) 役割プロンプト（GEMINI.md）で「読み取り・調査寄り」に限定すること
 *   (3) 必要なら gemini 側のサンドボックス（`--sandbox`）を足すこと
 * の 3 点である（docs/backends/gemini.md に明記）。
 *
 * - bypassPermissions / dontAsk / auto → yolo（engineer 役割の既定はここ）
 * - acceptEdits                        → auto_edit
 * - default / plan                     → default（＝人が張り付く前提。無人では止まる）
 * - 未指定(null)                       → yolo（PoC で検証した既定の起動形）
 */
export function toGeminiApprovalMode(mode: PermissionMode | null): GeminiApprovalMode {
  switch (mode) {
    case "acceptEdits":
      return "auto_edit";
    case "default":
    case "plan":
      return "default";
    case "bypassPermissions":
    case "dontAsk":
    case "auto":
    case null:
    case undefined:
    default:
      return "yolo";
  }
}

/**
 * モデル指定を gemini 用に解決する。
 *
 * ebi-team の役割既定モデル（engineer は "claude-opus-5"）がそのまま `-m` に流れると
 * 404 で即死するため、**gemini 系でないモデル名は既定モデルへ落とす**。
 * 役割ごとの backend 別モデル既定は PR-E（EbiRole.backend / config.backends）で入る。
 */
export function resolveGeminiModel(model: string | null): string {
  if (model && /^gemini[-.]/i.test(model)) return model;
  return GEMINI_DEFAULT_MODEL;
}

/**
 * per-エビ settings に載せる追加項目（mcpSpec.ts の GeminiSystemSettings を拡張）。
 * `context.includeDirectories` + `loadMemoryFromIncludeDirectories` で、**worktree を汚さずに**
 * 役割プロンプト（per-エビ GEMINI.md）を読ませる（後述 buildGeminiSettings）。
 */
export interface GeminiEbiSettings extends GeminiSystemSettings {
  context?: {
    includeDirectories: string[];
    loadMemoryFromIncludeDirectories: boolean;
  };
}

/** claude 方言の MCP config（--mcp-config JSON）1 エントリ分の形。 */
interface ClaudeMcpServerEntry {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * 既存の claude 用 MCP config（`.ebi-team/engineer-control.mcp.json`）を読み、
 * バックエンド中立表現（ControlMcpSpec）へ戻す純関数。
 *
 * 二重管理を作らないための措置: 制御MCP の command/args/cwd/接続先は
 * `scripts/gen-master-mcp.mjs` が生成する JSON が唯一の実体で、gemini はそれを
 * 読み直して自分の方言（system settings）へ射影するだけにする。
 *
 * env の追加分:
 * - `EBI_ID`: gemini には親 env 継承もあるが、**直接焼く**（claude 経路との差で
 *   from が空になる事故を作らない）。
 * - `EBI_NOTIFY_SUBSCRIBE=off`: gemini は `notifications/claude/channel` を持たないので
 *   購読ループを回さない（受信は PTY 注入に一本化。hasControlBridge も false）。
 */
export function controlMcpSpecFromClaudeConfig(
  rawJson: string,
  opts: { agentId: string; name?: string },
): ControlMcpSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(`MCP config の JSON を解析できません: ${(err as Error).message}`);
  }
  const servers = (parsed as { mcpServers?: Record<string, ClaudeMcpServerEntry> })?.mcpServers;
  if (!servers || typeof servers !== "object") {
    throw new Error("MCP config に mcpServers がありません");
  }
  const name = opts.name ?? EBI_CONTROL_MCP_NAME;
  const entry = servers[name] ?? servers[Object.keys(servers)[0]];
  if (!entry || typeof entry.command !== "string") {
    throw new Error(`MCP config に "${name}" のエントリがありません`);
  }
  return {
    name,
    command: entry.command,
    args: [...(entry.args ?? [])],
    cwd: entry.cwd ?? process.cwd(),
    env: {
      ...(entry.env ?? {}),
      EBI_ID: opts.agentId,
      EBI_NOTIFY_SUBSCRIBE: "off",
    },
  };
}

/**
 * per-エビ system settings を組み立てる純関数。
 *
 * - MCP 分（folderTrust / autoUpdate / useAlternateBuffer / trust:true）は
 *   mcpSpec.ts の `toGeminiSystemSettings()` が SoT。spec が null（制御MCP なし）でも
 *   **ゲート無効化のためだけに settings は必要**なので、mcpServers を空で作る。
 * - `context.includeDirectories`: 役割プロンプトを書いた per-エビ GEMINI.md の置き場を
 *   指す。`loadMemoryFromIncludeDirectories:true` で当該ディレクトリの GEMINI.md も
 *   コンテキストとして読み込まれる。**エビの worktree にファイルを置かずに済む**うえ、
 *   ボスの `~/.gemini/GEMINI.md`（グローバル共有コンテキスト）も従来どおり読み込まれるので
 *   共存する（上書きしない）。
 */
export function buildGeminiSettings(
  spec: ControlMcpSpec | null,
  opts?: { contextDir?: string | null; authType?: string | null },
): GeminiEbiSettings {
  const base = spec
    ? toGeminiSystemSettings(spec, { authType: opts?.authType ?? null })
    : {
        ...toGeminiSystemSettings(
          { name: "_placeholder", command: "true", args: [], cwd: ".", env: {} },
          { authType: opts?.authType ?? null },
        ),
        mcpServers: {},
      };
  const settings: GeminiEbiSettings = { ...base };
  if (opts?.contextDir) {
    settings.context = {
      includeDirectories: [opts.contextDir],
      loadMemoryFromIncludeDirectories: true,
    };
  }
  return settings;
}

/** per-エビ runtime ディレクトリ（エビの作業ディレクトリの外）。 */
export function geminiRuntimeDir(agentId: string, baseDir?: string): string {
  const base =
    baseDir ?? process.env[GEMINI_RUNTIME_DIR_ENV] ?? join(process.cwd(), ".ebi-team", "gemini");
  return join(base, agentId);
}

/**
 * per-エビ runtime（settings.json ＋ 役割 GEMINI.md）を書き出し、pty へ渡す env を返す。
 * 書き出し先は**エビの作業ディレクトリの外**（既定 `<サーバcwd>/.ebi-team/gemini/<agentId>/`）。
 */
export function writeGeminiRuntime(input: {
  agentId: string;
  /** claude 方言の MCP config パス（null なら制御MCP なしで起動）。 */
  mcpConfigPath: string | null;
  /** 役割注入プロンプト（GEMINI.md として書き出す。null なら書かない）。 */
  systemPrompt: string | null;
  /** 出力先ベース（テスト用）。既定は EBI_GEMINI_RUNTIME_DIR / <cwd>/.ebi-team/gemini。 */
  baseDir?: string;
}): Record<string, string> {
  const dir = geminiRuntimeDir(input.agentId, input.baseDir);
  mkdirSync(dir, { recursive: true });

  const spec = input.mcpConfigPath
    ? controlMcpSpecFromClaudeConfig(readFileSync(input.mcpConfigPath, "utf8"), {
        agentId: input.agentId,
      })
    : null;

  let contextDir: string | null = null;
  if (input.systemPrompt && input.systemPrompt.trim() !== "") {
    contextDir = dir;
    writeFileSync(join(dir, "GEMINI.md"), `${roleContextMarkdown(input.systemPrompt)}\n`, "utf8");
  }

  const settings = buildGeminiSettings(spec, { contextDir, authType: "oauth-personal" });
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return { [GEMINI_SETTINGS_ENV]: settingsPath };
}

/**
 * 役割プロンプトを GEMINI.md 本文へ整形する。
 * `~/.gemini/GEMINI.md`（ボスの共有コンテキスト）と並んで読み込まれるため、
 * 「これはこのセッション固有の役割である」と分かる見出しを付ける。
 */
export function roleContextMarkdown(systemPrompt: string): string {
  return `# エビチーム: このセッションの役割\n\n${systemPrompt.trim()}\n`;
}

/** Gemini CLI バックエンド。 */
export const GEMINI_BACKEND: EbiBackend = {
  // 性質（envDenyList / reportsUsage / idleThresholdMs / killProcessGroup / preflight /
  // initialPromptArgs）は profiles.ts が SoT。
  ...GEMINI_TRAITS,

  id: "gemini",
  defaultCommand: "gemini",

  matches(command: string): boolean {
    return command === "gemini" || command.endsWith("/gemini");
  },

  /**
   * 起動引数（PoC で 20/20 成立した形）:
   *   -m <model> --approval-mode <mode> [--allowed-mcp-server-names ebi-control]? ...extraArgs
   *
   * - `--allowed-mcp-server-names` は settings 側の `trust:true` と二重の保険
   *   （制御MCP を持たせるときだけ付ける）。
   * - 役割プロンプト（systemPrompt）は引数で渡さない。gemini に `--append-system-prompt`
   *   相当は無く、`GEMINI_SYSTEM_MD` は**コアのシステムプロンプトを丸ごと差し替える**ため
   *   ツール利用の指示ごと壊れる。よって per-エビ GEMINI.md（buildEnv 側）で注入する。
   * - 初回タスクも引数（`-i`）では渡さない。ebi-team の spawn API は「spawn → send_message」
   *   の 2 段で、spawn 時点ではタスク本文が無いのが通常経路のため。`-i` 自体は PoC で
   *   成立しており、traits.initialPromptArgs として残してある（PR-E 以降の一括起動用）。
   */
  buildArgs(input: BackendLaunchInput): string[] {
    const args: string[] = [
      MODEL_FLAG,
      resolveGeminiModel(input.model),
      APPROVAL_MODE_FLAG,
      toGeminiApprovalMode(input.permissionMode),
    ];
    if (input.mcpConfigPath) args.push(ALLOWED_MCP_FLAG, EBI_CONTROL_MCP_NAME);
    args.push(...input.extraArgs);
    return args;
  },

  /**
   * per-エビ system settings を書き出し、そのパスを env で渡す。
   * `inlineTui:false`（EBI_INLINE_TUI=off）でも**落とさない**: この env は「TUI の描画方式」
   * ではなく MCP・起動ゲート無効化・自動更新停止という**起動の必須条件**だから。
   */
  buildEnv(input?: BackendEnvInput): Record<string, string> {
    const agentId = input?.agentId;
    if (!agentId) return {};
    return writeGeminiRuntime({
      agentId,
      mcpConfigPath: input?.mcpConfigPath ?? null,
      systemPrompt: input?.systemPrompt ?? null,
    });
  },

  // gemini は Claude harness の `notifications/claude/channel` を持たない。
  // 受信は PTY 注入に一本化する（配送側は hasControlBridge=false で即 PTY へ落ちる）。
  supportsChannelInject: false,

  /**
   * 常に false。
   * この述語は「notification 購読が期待できるか（＝ブリッジ ACK を待つ価値があるか）」を問うもので、
   * 制御MCP の有無そのものではない。gemini は購読ループを回さない（EBI_NOTIFY_SUBSCRIBE=off）ので、
   * 待たずに PTY 注入へ落とすのが正しい。
   */
  hasControlBridge(): boolean {
    return false;
  },

  /**
   * 起動ゲートは settings（`security.folderTrust.enabled=false`）で消すため null。
   * ダイアログ自動応答は `~/.gemini/trustedFolders.json`（共有ファイル）を作ってしまうので採らない。
   */
  startupGates: null,

  /**
   * ready 判定は「プロンプト（入力欄）の表示」で行う。
   *
   * gemini は起動途中に **OAuth トークンの再取得**で
   * `Waiting for authentication... (Press Esc or Ctrl+C to cancel)` を出して沈黙することがあり、
   * 「boot 猶予＋初回 idle」だけだとそこを ready と誤判定して 1 通目の注入が丸ごと食われる
   * （e2e で実際に発生）。入力欄のプレースホルダが描画されるまで ready にしない。
   */
  readyPattern: /Type your message/,

  /**
   * 起動時に出たら待っても無駄な致命エラー。
   *
   * `GOOGLE_CLOUD_PROJECT` は **必須にしていない**（Workspace 垢では必須／個人垢では
   * 設定してはいけない、という相反する条件があり、ebi-team 側でアカウント種別を
   * 決め打ちしないため。preflight の requiredEnv は空）。代わりに、Workspace 垢で
   * 未設定だった場合に gemini 自身が出すこのエラーを拾って明示する。
   */
  fatalPatterns: [
    {
      pattern: /requires setting the GOOGLE_CLOUD_PROJECT/i,
      message:
        "gemini がログイン中のアカウント（Workspace 垢）で GOOGLE_CLOUD_PROJECT を要求しています。" +
        "サーバの env に GOOGLE_CLOUD_PROJECT を設定するか、個人 Google アカウントでログインし直してください" +
        "（docs/backends/gemini.md「2 つのログインモード」参照）",
    },
  ],

  // `-i "<task>"` で初回タスクを渡せる（PoC 実測）。既定経路では使わない（buildArgs のコメント参照）。
  supportsInitialPrompt: true,
};
