// バックエンドごとの「性質（BackendTraits）」の唯一の SoT。
//
// EbiBackend の実装本体（起動引数の組み立て）は backend ごとのファイルに書くが、
// PoC で判明した固有事情（課金経路を切る env / usage 報告の可否 / idle しきい値 /
// 初回タスクの渡し方 / kill の作法 / 起動前チェック）はここにデータとして集約する。
// codex / gemini は PR-C / PR-D で実装本体が入るまで、このプロファイルだけが存在する
// （＝「器」。未実装 backend の spawn 指定は index.ts が明示エラーで弾く）。

import type { AckFailureWatchSpec, BackendId, BackendTraits } from "./types.ts";

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
 * codex の「静かな故障」を示す ACK 文面（docs/backends/codex.md §7.1 / §7.2 の失敗の型）。
 *
 * 実測された文面（言い回しは毎回ぶれる。**同じ意味の別表現**が出ることを前提に広めに取る）:
 *   「ただし、この環境では reply_to_master ツールが利用できないため、現時点では master へ送信できません。」
 *   「reply_to_master ツールがこの環境で利用できないため、呼び出せません」
 *   「この環境には reply_to_master ツールが提供されていないため、master へのツール経由の報告は実行できません。」
 *     ← 2026-09-05 の実装後 e2e で観測。初版（`利用でき` 系だけ）では**取りこぼした**
 *
 * 成功ラウンドの ACK（「承知しました。テスト用の疎通係として対応します。」）には
 * これらの語が 1 件も出ないことを実測で確認済み。
 * 役割プロンプト本文（＝注入時に TUI がエコーする文字列）にもこれらの語は含まれない
 * （含めてしまうとエコーで誤検知するため、役割プロンプトを書くときの制約でもある。
 *  test/codexAckRespawn.test.ts が組込み役割・e2e のタスク本文で錠前を掛けている）。
 */
export const CODEX_ACK_FAILURE_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly message: string;
}[] = [
  {
    pattern: /(利用|使用)でき(ない|ません|ず)/,
    message: "エビが『ツールを利用できない』と応答しました（静かな故障）",
  },
  {
    pattern: /(呼び出せません|呼び出せない|使えません)/,
    message: "エビが『ツールを呼び出せない』と応答しました（静かな故障）",
  },
  {
    // 「ツールが提供されていない／登録されていない」型。
    pattern: /(提供|登録|用意)されて(いない|いません|おらず)/,
    message: "エビが『ツールが提供されていない』と応答しました（静かな故障）",
  },
  {
    // 「報告は実行できません／送信できません」型（ツールに触れずに結論だけ書く言い回し）。
    pattern: /(実行|送信|報告)でき(ない|ません|ず)/,
    message: "エビが『報告を実行できない』と応答しました（静かな故障）",
  },
  {
    pattern: /(tool|tools)[^\n]{0,40}(not available|unavailable|not provided|not registered)/i,
    message: "エビが英語で『ツールが利用できない』と応答しました（静かな故障）",
  },
];

/**
 * codex の ACK 監視設定。
 * - windowMs: 役割プロンプト注入からの監視上限。実測の ACK 所要は 30 秒前後なので既定 90 秒。
 * - minObserveMs: 注入本文エコーだけの busy→idle で「成功 ACK」と誤判定しないための下限。
 * env `EBI_CODEX_ACK_WATCH_MS` / `EBI_CODEX_ACK_MIN_OBSERVE_MS` で調整可。
 */
export const CODEX_ACK_FAILURE_WATCH: AckFailureWatchSpec = {
  patterns: CODEX_ACK_FAILURE_PATTERNS,
  windowMs: Number(process.env.EBI_CODEX_ACK_WATCH_MS) || 90000,
  minObserveMs: Number(process.env.EBI_CODEX_ACK_MIN_OBSERVE_MS) || 3000,
};

/**
 * ACK 文面から静かな故障を検知する純関数（検知ロジックの SoT）。
 * 最初に一致したパターンの説明文を返す。一致しなければ null。
 */
export function matchAckFailure(
  plainText: string,
  patterns: readonly { readonly pattern: RegExp; readonly message: string }[],
): { pattern: RegExp; message: string } | null {
  for (const entry of patterns) {
    if (entry.pattern.test(plainText)) return entry;
  }
  return null;
}

/**
 * codex のプロファイル（PR0-C 実測・codex-cli 0.146.0）。
 * - 待機中の PTY 出力は 60 秒で 0 バイト → idleThresholdMs は上書き不要。
 * - 初回タスクは位置引数で「渡せる」（CLI 能力）。ただし ebi-team の運用としては使わない
 *   （MCP 起動と競合するため ready 後に PTY 注入する。backends/codex.ts 参照＝能力と方針の分離）。
 * - 認証は `~/.codex/auth.json`（`codex login status` = Logged in using ChatGPT）。
 * - kill はプロセスグループごと（PR-D 実測）: codex は組込み MCP `codex_apps` を常に 1 本立て、
 *   ebi-control を足せば子 stdio MCP がもう 1 本増える。PTY リーダだけ落とすと孤児になりうるため、
 *   node-pty が作る新セッション（= 子が pgid のリーダ）へまとめてシグナルを送る。
 */
export const CODEX_TRAITS: BackendTraits = {
  envDenyList: [],
  reportsUsage: false,
  idleThresholdMs: null,
  killProcessGroup: true,
  // 役割プロンプト ACK の「静かな故障」を検知したら 1 回だけ作り直す（docs §7.1 の次の一手 1）。
  ackFailureWatch: CODEX_ACK_FAILURE_WATCH,
  preflight: {
    versionArgs: ["--version"],
    verifiedVersion: "0.146.0",
    requiredFiles: ["~/.codex/auth.json"],
    requiredEnv: [],
    // `codex login status` は結果を **stderr** に出す（0.146.0 実測）。
    // backendPreflight.ts は stdout+stderr を連結して照合する。
    // 正常時は `Logged in using ChatGPT`。`/Logged in/i` だと "Not logged in" にも
    // 一致してしまうため（大小無視）、"using" まで含めて照合する。
    loginCheck: { args: ["login", "status"], okPattern: /Logged in using/i },
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
