// バックエンド・レジストリと解決ロジック。
//
// 呼び出し側（index.ts / config.ts / agent.ts / registry.ts）はここだけを見る。
// 「command 名が claude か？」という判定をこのモジュールの外に書かないこと
// （以前は index.ts / config.ts / registry.ts の 3 箇所に同じ式が重複していた）。

import { CLAUDE_BACKEND } from "./claude.ts";
import { CODEX_BACKEND } from "./codex.ts";
import { GEMINI_BACKEND } from "./gemini.ts";
import { ALL_BACKEND_IDS } from "./types.ts";
import type { BackendId, BackendLaunchInput, EbiBackend } from "./types.ts";

export type {
  BackendId,
  BackendEnvInput,
  BackendLaunchInput,
  BackendPreflightSpec,
  BackendTraits,
  ControlMcpSpec,
  EbiBackend,
  PermissionMode,
  StartupGateKind,
  StartupGateSpec,
} from "./types.ts";
export { ALL_BACKEND_IDS, PERMISSION_MODES } from "./types.ts";
export {
  CLAUDE_BACKEND,
  BASE_ALLOWED_DEV_CHANNELS,
  EBI_CONTROL_CHANNEL_SPEC,
  EBI_CONTROL_MCP_NAME,
  detectStartupGate,
  isDevChannelsAutoAnswerEligible,
} from "./claude.ts";
export {
  CODEX_BACKEND,
  CODEX_VERIFIED_VERSION,
  codexSandboxFor,
  type CodexSandbox,
} from "./codex.ts";
export {
  GEMINI_BACKEND,
  GEMINI_DEFAULT_MODEL,
  GEMINI_HEAVY_MODEL,
  GEMINI_SETTINGS_ENV,
  GEMINI_VERIFIED_VERSION,
  buildGeminiSettings,
  controlMcpSpecFromClaudeConfig,
  geminiRuntimeDir,
  resolveGeminiModel,
  toGeminiApprovalMode,
  writeGeminiRuntime,
  type GeminiApprovalMode,
  type GeminiEbiSettings,
} from "./gemini.ts";
export {
  BACKEND_TRAITS,
  CLAUDE_TRAITS,
  CODEX_TRAITS,
  GEMINI_TRAITS,
  DEFAULT_IDLE_THRESHOLD_MS,
  applyEnvDenyList,
  resolveIdleThresholdMs,
} from "./profiles.ts";
export {
  evaluatePreflight,
  expandHome,
  type PreflightProbe,
  type PreflightResult,
} from "./preflight.ts";
export {
  toClaudeMcpConfig,
  toCodexConfigArgs,
  toCodexProjectsTrustArgs,
  toGeminiSystemSettings,
  type ClaudeMcpConfig,
  type GeminiSystemSettings,
} from "./mcpSpec.ts";

/** 実装済みバックエンドの一覧（解決の探索順）。claude / codex(PR-D) / gemini(PR-C)。 */
export const BACKENDS: readonly EbiBackend[] = [CLAUDE_BACKEND, CODEX_BACKEND, GEMINI_BACKEND];

/** 最終フォールバックのバックエンド id。 */
export const DEFAULT_BACKEND_ID: BackendId = "claude";

/** 現時点で選択可能な（実装済みの）バックエンド id 一覧。 */
export const IMPLEMENTED_BACKEND_IDS: readonly BackendId[] = BACKENDS.map((b) => b.id);

/** 文字列が実装済みバックエンド id かを判定する型ガード。 */
export function isImplementedBackendId(value: string | undefined | null): value is BackendId {
  return value != null && (IMPLEMENTED_BACKEND_IDS as readonly string[]).includes(value);
}

/** 文字列が（未実装を含む）既知のバックエンド id かを判定する型ガード。 */
export function isKnownBackendId(value: string | undefined | null): value is BackendId {
  return value != null && (ALL_BACKEND_IDS as readonly string[]).includes(value);
}

/**
 * 未実装／不正な backend id に対する共通エラー文言。
 * 「型としては存在するがまだ実装されていない（codex / gemini）」と「そもそも知らない id」を
 * 区別して伝える（黙って claude に落とさない）。
 */
export function backendIdError(value: string): Error {
  if (isKnownBackendId(value)) {
    return new Error(
      `backend "${value}" は未実装です（実装済み: ${IMPLEMENTED_BACKEND_IDS.join(", ")}）`,
    );
  }
  return new Error(
    `backend が不正です: ${value}（許容: ${IMPLEMENTED_BACKEND_IDS.join(", ")}）`,
  );
}

/** id からバックエンドを引く。未実装 id は throw（黙って claude に落とさない）。 */
export function getBackend(id: BackendId): EbiBackend {
  const found = BACKENDS.find((b) => b.id === id);
  if (!found) throw backendIdError(id);
  return found;
}

/**
 * 起動コマンド名からバックエンドを引く。どれにも一致しなければ null。
 *
 * null は「素のシェル/スタブ起動（EBI_COMMAND=bash 等のテスト用逃げ道）」を意味し、
 * その場合はバックエンド固有フラグ・env を一切付けない（bash が解釈できず即終了→
 * crashloop になるのを防ぐ、従来からの方針）。
 */
export function resolveBackend(command: string): EbiBackend | null {
  return BACKENDS.find((b) => b.matches(command)) ?? null;
}

/**
 * 起動コマンド名からバックエンドを引き、一致が無ければ既定（claude）を返す。
 * 「フラグを付けるか」ではなく「env の既定値をどう敷くか」等、スタブ起動でも従来どおり
 * claude 相当の既定を適用したい箇所で使う。
 */
export function resolveBackendOrDefault(command: string): EbiBackend {
  return resolveBackend(command) ?? getBackend(DEFAULT_BACKEND_ID);
}

/**
 * バックエンド id を解決する。優先度は
 *   spawn 引数 > 役割(EbiRole) > config.defaultBackend > env EBI_BACKEND > "claude"。
 * 未知 id は throw する（黙って claude に落とさない）。
 * ※ PR-D 時点で claude / codex / gemini の 3 つとも実装済み。
 */
export function resolveBackendId(sources?: {
  /** spawn 引数での明示指定。 */
  explicit?: string | null;
  /** 役割（EbiRole）の既定。 */
  role?: string | null;
  /** ebi-team.config.json の defaultBackend。 */
  configDefault?: string | null;
  /** env EBI_BACKEND。 */
  env?: string | null;
}): BackendId {
  const candidates = [sources?.explicit, sources?.role, sources?.configDefault, sources?.env];
  for (const raw of candidates) {
    if (raw == null || raw === "") continue;
    if (!isImplementedBackendId(raw)) throw backendIdError(raw);
    return raw;
  }
  return DEFAULT_BACKEND_ID;
}

/**
 * 起動引数を組み立てる共通入口（固定エビ / 動的エビの双方が通る唯一の経路）。
 * command に一致するバックエンドが無ければ extraArgs のみを返す（スタブ起動の逃げ道）。
 */
export function buildLaunchArgs(command: string, input: BackendLaunchInput): string[] {
  const backend = resolveBackend(command);
  if (!backend) return [...input.extraArgs];
  return backend.buildArgs(input);
}

/**
 * ready 到達後に一度だけ PTY 注入する本文（役割プロンプト）を返す。
 * `--append-system-prompt` 相当を持たない backend（codex）だけが値を返し、claude は null。
 * command に一致する backend が無ければ null（スタブ起動の逃げ道。buildLaunchArgs と同じ規約）。
 */
export function initialInjectFor(command: string, input: BackendLaunchInput): string | null {
  const backend = resolveBackend(command);
  return backend?.initialInjectText?.(input) ?? null;
}
