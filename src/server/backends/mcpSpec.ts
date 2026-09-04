// 制御MCP（ebi-control）の起動情報を「バックエンド中立な 1 オブジェクト」で持ち、
// 各 CLI の方言へ射影する純関数群。
//
// 設計方針:
// - SoT は ControlMcpSpec ただ 1 つ。claude 用 JSON / codex 用 -c TOML / gemini 用 settings.json を
//   別々に手書きしない（二重管理を作らない）。scripts/gen-master-mcp.mjs もこのモジュールを使う。
// - 射影はすべて**純関数**（ファイル I/O もプロセス起動もしない）。呼び出し側が書き出す。
// - このファイルは node 組込みに依存しない（types.ts と同じ制約）。

import type { ControlMcpSpec } from "./types.ts";

export type { ControlMcpSpec } from "./types.ts";

/** claude 用 `--mcp-config` に渡す JSON の形（mcpServers マップ）。 */
export interface ClaudeMcpConfig {
  mcpServers: Record<
    string,
    { command: string; args: string[]; cwd: string; env: Record<string, string> }
  >;
}

/**
 * claude 方言: `--mcp-config <path>` に渡す JSON オブジェクトを返す。
 *
 * キー順（command → args → cwd → env）は **既存 .ebi-team/*.mcp.json の出力と
 * バイト単位で一致させるため固定**（gen-master-mcp.mjs の差分ゼロをテストで担保している）。
 */
export function toClaudeMcpConfig(spec: ControlMcpSpec): ClaudeMcpConfig {
  return {
    mcpServers: {
      [spec.name]: {
        command: spec.command,
        args: [...spec.args],
        cwd: spec.cwd,
        env: { ...spec.env },
      },
    },
  };
}

/** TOML の基本文字列としてクォートする（`"` と `\` のみエスケープすれば足りる用途）。 */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** TOML のインラインテーブル（`{K="v",...}`）を組み立てる。 */
function tomlInlineTable(env: Record<string, string>): string {
  const body = Object.entries(env)
    .map(([k, v]) => `${k}=${tomlString(v)}`)
    .join(",");
  return `{${body}}`;
}

/**
 * codex 方言: `-c <key=value>` のインライン TOML 上書き列を返す（`-c` を含む平坦な配列）。
 *
 * PoC（0.146.0）実測で判明した必須事項:
 * - `mcp_servers.<name>.default_tools_approval_mode="approve"` が無いと、MCP ツール呼び出しの
 *   たびに承認ダイアログで停止する（`-a never` では抑止されない＝承認系統が別）。
 *   値域は auto / prompt / writes / approve で、**auto ではダイアログが出る**。
 * - env はドット記法ではなくインラインテーブルで渡す。
 */
export function toCodexConfigArgs(
  spec: ControlMcpSpec,
  opts?: {
    /**
     * MCP サーバの起動待ち上限（秒）。未指定なら付けない（codex 既定に従う）。
     *
     * PR-D 実測: 開発起動（`npx tsx src/mcp/control-server.ts`）は初期化に数秒かかり、
     * codex 既定の待ちでは間に合わずツールが「利用できない」状態のまま先へ進む
     * （= reply_to_master が永久に飛ばない静かな故障）。明示的に広げる。
     */
    startupTimeoutSec?: number;
  },
): string[] {
  const key = `mcp_servers.${spec.name}`;
  const argsToml = `[${spec.args.map(tomlString).join(",")}]`;
  const args = [
    "-c", `${key}.command=${tomlString(spec.command)}`,
    "-c", `${key}.args=${argsToml}`,
    "-c", `${key}.cwd=${tomlString(spec.cwd)}`,
    "-c", `${key}.default_tools_approval_mode="approve"`,
    "-c", `${key}.env=${tomlInlineTable(spec.env)}`,
  ];
  if (opts?.startupTimeoutSec != null) {
    args.push("-c", `${key}.startup_timeout_sec=${opts.startupTimeoutSec}`);
  }
  return args;
}

/**
 * codex 方言: フォルダ信頼を宣言する `-c projects={...}` を返す（`-c` を含む平坦な配列）。
 * paths が空なら空配列（＝フラグを付けない）。
 *
 * PoC（0.146.0）実測:
 * - これが無いと「Do you trust the contents of this directory?」ゲートで無人 spawn が停止する。
 * - **ドット記法（`-c projects."<path>".trust_level="trusted"`）は黙って無視される**。
 *   インラインテーブル形式で渡すこと。
 * - worktree は git サブディレクトリ扱いなので repo root と worktree の**両方**を入れる。
 */
export function toCodexProjectsTrustArgs(paths: readonly string[]): string[] {
  const uniq = [...new Set(paths.filter((p) => p.length > 0))];
  if (uniq.length === 0) return [];
  const body = uniq.map((p) => `${tomlString(p)}={trust_level="trusted"}`).join(",");
  return ["-c", `projects={${body}}`];
}

/** gemini 用 system settings（`GEMINI_CLI_SYSTEM_SETTINGS_PATH` で差し込む JSON）の形。 */
export interface GeminiSystemSettings {
  ui: { useAlternateBuffer: boolean };
  security: {
    folderTrust: { enabled: boolean };
    auth?: { selectedType: string };
  };
  general: { enableAutoUpdate: boolean; checkForUpdates: boolean };
  mcpServers: Record<
    string,
    {
      command: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      trust: boolean;
    }
  >;
}

/**
 * gemini 方言: `GEMINI_CLI_SYSTEM_SETTINGS_PATH` に置く settings.json を返す。
 *
 * PoC（0.58.0）実測で判明した必須事項:
 * - `security.folderTrust.enabled=false`: 0.58.0 は folderTrust が既定 on になっており、
 *   初回起動でフォルダ信頼ゲートが出て 1 通目の注入が食われる。ダイアログ自動応答ではなく
 *   settings で消す（`~/.gemini/trustedFolders.json` という共有ファイルを汚さないため）。
 * - `general.enableAutoUpdate=false` / `checkForUpdates=false`: 自動更新が走ると 20〜25 秒
 *   無出力になり、その間の注入が宙に浮く。
 * - `ui.useAlternateBuffer=false`: 既定 false だが、ユーザ設定変更に対する防御で明示する。
 * - `mcpServers.<name>.trust=true`: ツール呼び出しの確認プロンプトを省く（無人運用の必須条件）。
 */
export function toGeminiSystemSettings(
  spec: ControlMcpSpec,
  opts?: { authType?: string | null },
): GeminiSystemSettings {
  const security: GeminiSystemSettings["security"] = { folderTrust: { enabled: false } };
  if (opts?.authType) security.auth = { selectedType: opts.authType };
  return {
    ui: { useAlternateBuffer: false },
    security,
    general: { enableAutoUpdate: false, checkForUpdates: false },
    mcpServers: {
      [spec.name]: {
        command: spec.command,
        args: [...spec.args],
        cwd: spec.cwd,
        env: { ...spec.env },
        trust: true,
      },
    },
  };
}
