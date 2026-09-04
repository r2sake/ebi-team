// Codex CLI（OpenAI・codex-cli）バックエンド実装。
//
// 起動形は PoC（docs/poc/codex-poc-2026-09-04.md・0.146.0 実測）で確定したものをそのまま持つ:
//   codex --no-alt-screen [-m MODEL] -s <sandbox> -a never
//         -c disable_paste_burst=true
//         -c check_for_update_on_startup=false
//         -c 'projects={"<repo>"={trust_level="trusted"},"<worktree>"={trust_level="trusted"}}'
//         -c 'mcp_servers.ebi-control...'（toCodexConfigArgs）
//
// 設計上の要点（すべて PoC 実測に基づく）:
// - **起動ゲートは「自動応答」ではなく「出させない」**。update ダイアログ・フォルダ信頼ダイアログ・
//   MCP ツール承認ダイアログの 3 つを設定で潰す（承認の自動クリックという危険な機構を増やさない）。
//   よって startupGates は null。
// - **初回タスクは位置引数で渡さない**。位置引数で渡すと boot 中に
//   `⚠ MCP startup interrupted ... codex_apps, ebi-control` が出る（PoC §5）。
//   役割プロンプトは ready 後に PTY 注入する（initialInjectText）。
//   CLI 能力としては位置引数を取れる（profiles.ts の CODEX_TRAITS.initialPromptArgs）が、
//   ebi-team の**運用方針**として使わない、という切り分け。
// - `--append-system-prompt` 相当が無いため、役割プロンプトは初回 PTY 注入で載せる（R7 対策）。
// - notification（channel）注入は Claude harness 固有機能なので非対応（PTY 注入経路に落ちる）。

import { toCodexConfigArgs, toCodexProjectsTrustArgs } from "./mcpSpec.ts";
import { CODEX_TRAITS } from "./profiles.ts";
import type {
  BackendEnvInput,
  BackendLaunchInput,
  EbiBackend,
  PermissionMode,
} from "./types.ts";

/** PoC で検証済みの codex-cli バージョン（preflight の警告判定に使う）。profiles.ts が SoT。 */
export const CODEX_VERIFIED_VERSION = CODEX_TRAITS.preflight.verifiedVersion;

/**
 * 制御MCP（ebi-control）の起動待ち上限（秒）。
 * codex 既定のままだと、開発起動（`npx tsx`）の control-server が間に合わず
 * 「reply_to_master が使えない」まま会話が進む（PR-D の e2e で実測）。
 * env `EBI_CODEX_MCP_STARTUP_TIMEOUT_SEC` で調整可。
 */
const CONTROL_MCP_STARTUP_TIMEOUT_SEC =
  Number(process.env.EBI_CODEX_MCP_STARTUP_TIMEOUT_SEC) || 60;

/** codex のサンドボックス値（`-s, --sandbox`）。 */
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

/**
 * 抽象 permissionMode → codex `-s`（サンドボックス）の写像。
 *
 * 既定は**読み取り寄り**（設計書 Q-7 の推奨(b)）。まず下調べ・読解で信頼を積み、
 * 実装役は claude を維持する方針。ボスが望めば役割の permissionMode を上げるだけで
 * workspace-write / danger-full-access へ切り替わる。
 *
 * | permissionMode      | codex -s            | 意味                                   |
 * |---------------------|---------------------|----------------------------------------|
 * | (未指定 null)       | read-only           | 読み取りのみ                           |
 * | default             | read-only           | 読み取りのみ                           |
 * | plan                | read-only           | 読み取りのみ                           |
 * | acceptEdits         | workspace-write     | worktree 内の書き込み可                |
 * | auto                | workspace-write     | 同上                                   |
 * | dontAsk             | workspace-write     | 同上                                   |
 * | bypassPermissions   | danger-full-access  | サンドボックス無効（claude の bypass 相当） |
 *
 * `-a`（承認）は常に never。`on-request` は無人運用で承認待ちのまま固まるため使わない（PoC §5-7）。
 */
export function codexSandboxFor(mode: PermissionMode | null): CodexSandbox {
  switch (mode) {
    case "bypassPermissions":
      return "danger-full-access";
    case "acceptEdits":
    case "auto":
    case "dontAsk":
      return "workspace-write";
    case "default":
    case "plan":
    case null:
    case undefined:
    default:
      return "read-only";
  }
}

/** `codex login status` の判定材料（preflight で使う）。 */
export const CODEX_LOGIN_CHECK = {
  args: ["login", "status"] as readonly string[],
  /** 正常時の出力（例: `Logged in using ChatGPT`）。 */
  okPattern: /Logged in/i,
} as const;

/** Codex CLI バックエンド。 */
export const CODEX_BACKEND: EbiBackend = {
  // 性質（envDenyList / reportsUsage / idleThresholdMs / killProcessGroup / preflight /
  // initialPromptArgs）は profiles.ts の CODEX_TRAITS が SoT。
  ...CODEX_TRAITS,

  id: "codex",
  defaultCommand: "codex",

  matches(command: string): boolean {
    return command === "codex" || command.endsWith("/codex");
  },

  /**
   * 起動引数の組み立て（PoC 実証済みの並び）。
   *
   *   --no-alt-screen [-m MODEL] -s <sandbox> -a never
   *   -c disable_paste_burst=true
   *   -c check_for_update_on_startup=false
   *   [-c 'projects={...}']?           trustPaths がある場合のみ
   *   [...toCodexConfigArgs(spec)]?    controlMcp がある場合のみ（default_tools_approval_mode 込み）
   *   ...extraArgs
   *
   * systemPrompt は**引数に載せない**（codex に --append-system-prompt 相当が無い）。
   * ready 後に initialInjectText() の本文として PTY 注入する。
   */
  buildArgs(input: BackendLaunchInput): string[] {
    const args: string[] = ["--no-alt-screen"];
    if (input.model) args.push("-m", input.model);
    args.push("-s", codexSandboxFor(input.permissionMode), "-a", "never");
    // 起動ゲート（update ダイアログ）を出させない。無いと無人 spawn が停止する。
    args.push("-c", "disable_paste_burst=true");
    args.push("-c", "check_for_update_on_startup=false");
    // 組込み MCP `codex_apps`（ChatGPT アプリ連携）を止める。ebi-team では使わないうえ、
    // これがあると MCP 群の起動完了が十数秒遅れ、その間のターンは **ツール無し**で走る
    // （= reply_to_master が使えずチャットに答えて終わる静かな故障。PR-D の e2e で 10/10 再現）。
    // 止めると起動する MCP は ebi-control だけになり、数秒でツールが揃う。
    args.push("-c", "features.apps=false");
    // フォルダ信頼ゲートを出させない。worktree は git サブディレクトリ扱いなので
    // repo root と worktree の両方を trusted に入れる（PoC §3.1）。
    args.push(...toCodexProjectsTrustArgs(input.trustPaths ?? []));
    // 制御MCP（ebi-control）。承認ダイアログ抑止（default_tools_approval_mode）込みで射影する。
    if (input.controlMcp) {
      args.push(
        ...toCodexConfigArgs(input.controlMcp, { startupTimeoutSec: CONTROL_MCP_STARTUP_TIMEOUT_SEC }),
      );
    }
    args.push(...input.extraArgs);
    return args;
  },

  /**
   * codex は `--no-alt-screen` フラグでインライン描画になるため、env の既定は不要。
   * （claude だけが env 経由＝CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN を必要とする。）
   */
  buildEnv(_input?: BackendEnvInput): Record<string, string> {
    return {};
  },

  // `notifications/claude/channel` は Claude harness 固有。codex は PTY 注入経路で受ける。
  supportsChannelInject: false,

  /** `-c mcp_servers.ebi-control.command=...` が付いていれば制御MCP ブリッジ持ち。 */
  hasControlBridge(args: readonly string[]): boolean {
    return args.some((a) => a.startsWith("mcp_servers.ebi-control."));
  },

  // 起動ゲートは設定で出させないので自動応答の定義を持たない（危険な自動承認を増やさない）。
  startupGates: null,

  // CLI 能力としては位置引数を取れるが、MCP 起動と競合するため運用では使わない（上部コメント）。
  supportsInitialPrompt: false,
  initialPromptArgs: () => [],

  /**
   * ready 後に一度だけ PTY 注入する本文（役割プロンプト）。
   * codex には `--append-system-prompt` 相当が無いため、ここで役割・セキュリティ節を載せる。
   */
  initialInjectText(input: BackendLaunchInput): string | null {
    const prompt = input.systemPrompt?.trim();
    return prompt ? prompt : null;
  },

  /**
   * ready 昇格の追加猶予。TUI のプロンプトが出てから制御MCP のツールが揃うまでに
   * 数秒あり、その間に 1 通目を投げるとツール無しのターンになる（上記 features.apps の
   * コメント参照）。env `EBI_CODEX_READY_WARMUP_MS` で調整可。
   */
  readyWarmupMs: Number(process.env.EBI_CODEX_READY_WARMUP_MS) || 8000,

  /**
   * ready 昇格の追加条件（空白除去済みの起動出力に対する照合）。
   * codex TUI のバナー（`>_ OpenAI Codex (v0.146.0)`）が出るまでは ready にしない。
   * これで「起動直後に落ちた／ゲートで止まった」を沈黙 idle で ready と誤認しない。
   * 検知できないまま出力が止まった場合は従来判定へ degrade する（agent.ts 側の settle）。
   */
  readyPattern: /OpenAICodex\(v/i,
};
