// バックエンドごとの「性質（BackendTraits）」の唯一の SoT。
//
// EbiBackend の実装本体（起動引数の組み立て）は backend ごとのファイルに書くが、
// PoC で判明した固有事情（課金経路を切る env / usage 報告の可否 / idle しきい値 /
// 初回タスクの渡し方 / kill の作法 / 起動前チェック）はここにデータとして集約する。
// codex / gemini は PR-C / PR-D で実装本体が入るまで、このプロファイルだけが存在する
// （＝「器」。未実装 backend の spawn 指定は index.ts が明示エラーで弾く）。

import type { BackendId, BackendTraits } from "./types.ts";

/** idle 判定のサーバ既定（ms）。backend が idleThresholdMs=null ならこれを使う。 */
export const DEFAULT_IDLE_THRESHOLD_MS = 900;

/**
 * claude のプロファイル。**現状踏襲**（PR-B は挙動不変）。
 * envDenyList は空、プロセスグループ kill もしない、初回タスクは引数で渡さない。
 */
export const CLAUDE_TRAITS: BackendTraits = {
  envDenyList: [],
  reportsUsage: true,
  idleThresholdMs: null,
  killProcessGroup: false,
  preflight: {
    versionArgs: ["--version"],
    verifiedVersion: null,
    requiredFiles: [],
    requiredEnv: [],
  },
  initialPromptArgs: () => [],
};

/**
 * codex のプロファイル（PR0-C 実測・codex-cli 0.146.0）。
 * - 待機中の PTY 出力は 60 秒で 0 バイト → idleThresholdMs は上書き不要。
 * - 初回タスクは位置引数で渡せる。
 * - 認証は `~/.codex/auth.json`（`codex login status` = Logged in using ChatGPT）。
 */
export const CODEX_TRAITS: BackendTraits = {
  envDenyList: [],
  reportsUsage: false,
  idleThresholdMs: null,
  killProcessGroup: false,
  preflight: {
    versionArgs: ["--version"],
    verifiedVersion: "0.146.0",
    requiredFiles: ["~/.codex/auth.json"],
    requiredEnv: [],
  },
  initialPromptArgs: (prompt: string) => [prompt],
};

/**
 * gemini のプロファイル（PR0-G 実測・gemini-cli 0.58.0）。
 *
 * envDenyList は設計書 §2.5 の案から **訂正済み**:
 * Workspace アカウント（Code Assist Standard）では `GOOGLE_CLOUD_PROJECT` を落とすと
 * `ProjectIdRequiredError` で**起動すらできない**。よって deny しない。
 * deny するのは API キー課金・別認証経路のみ。
 *
 * `requiredEnv` は**空**（ボス裁定 2026-09-05 の変更後）。ログイン中のアカウントが
 * Workspace 垢（GCP プロジェクト必須）か個人垢（Google AI Pro 等・プロジェクト不要かつ
 * 設定すると GCP 紐付き経路に載ってしまう）かを ebi-team 側で決め打ちしないため。
 * 「あれば継承・無ければ無しで起動」し、Workspace 垢で未設定だった場合は起動時の
 * `This account requires setting the GOOGLE_CLOUD_PROJECT` を fatalPatterns で拾って
 * 明示エラーにする（backends/gemini.ts）。
 *
 * kill はプロセスグループ必須（gemini は子 node を再 exec するため、PTY リーダの kill だけでは
 * 子と配下の stdio MCP が孤児として残る。PoC で 21 プロセス残存を実測）。
 */
export const GEMINI_TRAITS: BackendTraits = {
  envDenyList: [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_GENAI_USE_GCA",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ],
  reportsUsage: false,
  idleThresholdMs: null,
  killProcessGroup: true,
  // 起動途中の予期せぬ exit（OAuth トークン再取得の失敗等）は 1 回だけ再試行する。
  retryOnEarlyExit: true,
  preflight: {
    versionArgs: ["--version"],
    verifiedVersion: "0.58.0",
    requiredFiles: ["~/.gemini/oauth_creds.json"],
    // 空（上記コメント参照）。Workspace 垢／個人垢のどちらでも起動できるようにする。
    requiredEnv: [],
  },
  initialPromptArgs: (prompt: string) => ["-i", prompt],
};

/** BackendId → プロファイル。未実装 backend もここには存在する（PR-C/PR-D の入力）。 */
export const BACKEND_TRAITS: Record<BackendId, BackendTraits> = {
  claude: CLAUDE_TRAITS,
  codex: CODEX_TRAITS,
  gemini: GEMINI_TRAITS,
};

/**
 * idle しきい値を解決する（backend の上書き > サーバ既定）。
 * claude / codex / gemini とも現状は上書き無し（= サーバ既定 900ms）。
 */
export function resolveIdleThresholdMs(
  backendIdleThresholdMs: number | null,
  serverDefault: number,
): number {
  return backendIdleThresholdMs ?? serverDefault;
}

/**
 * 親 env から backend の envDenyList のキーを落とす純関数。
 * ebi-team 自身が渡す env（launch.env / backend の既定 env）は対象外。
 */
export function applyEnvDenyList(
  parentEnv: Record<string, string | undefined>,
  denyList: readonly string[],
): Record<string, string | undefined> {
  if (denyList.length === 0) return parentEnv;
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (denyList.includes(key)) continue;
    out[key] = value;
  }
  return out;
}
