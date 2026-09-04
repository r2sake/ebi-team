// バックエンド（エビを動かすエージェント CLI）抽象の型定義。
//
// 設計方針:
// - ebi-team のサーバ骨格（node-pty 管理・idle 検出・scrollback・制御API・worktree）は
//   バックエンド非依存である。バックエンド固有なのは実質「起動コマンドラインの組み立て」
//   「pty env」「通信路の性質（channel 注入が使えるか / 制御MCP ブリッジを持つか）」
//   「起動ゲート（信頼ダイアログ等）の文言と応答」の 4 点だけ。
//   その 4 点を EbiBackend インターフェースに閉じ込め、他所からは `resolveBackend(command)`
//   越しにしか触らせない（= Claude 固有知識の散在を止める）。
// - このファイルは **node 組込みにも依存しない純粋な型/定数のみ**。
//   MCP 側（control-server.ts → roles.ts → config.ts）からも読まれる経路にあるため、
//   node-pty 等の重い依存を持ち込まないこと。

/**
 * permission-mode の抽象語彙。
 * 現行の Claude Code `--permission-mode` の値集合をそのまま抽象語彙として採用する
 * （新語彙を作ると ebi-team.config.json の互換が壊れるため）。
 * 他バックエンドを足す際は、この抽象値から各 CLI のフラグへ backend 側で写像する。
 */
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
 * バックエンド識別子。
 * **実装済みかどうかは別**（実装済みの集合は index.ts の IMPLEMENTED_BACKEND_IDS）。
 * "codex" / "gemini" は PR-B 時点では「器（型・プロファイル・MCP 方言射影・preflight 定義）」
 * だけがあり、EbiBackend 実装本体は PR-C / PR-D で入る。
 * 未実装 id を spawn 引数等で指定した場合は黙って claude に落とさず明示エラーにする。
 */
export type BackendId = "claude" | "codex" | "gemini";

/** 全バックエンド識別子（未実装を含む）。UI の選択肢や zod enum の SoT。 */
export const ALL_BACKEND_IDS = ["claude", "codex", "gemini"] as const;

/** 起動引数を組み立てるための入力（バックエンド非依存の抽象パラメータ）。 */
export interface BackendLaunchInput {
  /** 起動モデル（alias/full ID）。未指定なら null。 */
  model: string | null;
  /** permission-mode（抽象語彙）。未指定なら null。 */
  permissionMode: PermissionMode | null;
  /** 役割注入プロンプト（Claude の --append-system-prompt 相当）。未指定なら null。 */
  systemPrompt: string | null;
  /**
   * ebi-control MCP（reply_to_master 等）を持たせる場合の設定ファイルパス。
   * null なら制御MCP ブリッジ無しで起動する（素の dynamic エビ・テスト起動）。
   */
  mcpConfigPath: string | null;
  /**
   * notification（channel）注入モードが有効か。
   * 有効かつ mcpConfigPath がある場合、Claude は ebi-control をセッションの
   * dev channel として register する必要がある（後述 supportsChannelInject）。
   */
  notifyMode: boolean;
  /** 追加の任意引数（config の args / EBI_ARGS 由来）。常に末尾へ付く。 */
  extraArgs: string[];
  /**
   * 制御MCP（ebi-control）の中立表現。設定ファイル経由ではなく**起動引数に焼く**
   * バックエンド（codex の `-c mcp_servers.*`）が使う。null / 未指定なら制御MCP 無しで起動する。
   * claude は mcpConfigPath（JSON ファイル）側を使うため、この値を見ない。
   */
  controlMcp?: ControlMcpSpec | null;
  /**
   * 「信頼済み」として起動時に宣言するディレクトリ（repo root と worktree の両方を渡す）。
   * codex のフォルダ信頼ゲートを**出させない**ために使う（PoC §3.1）。
   * 未指定なら宣言しない。claude は workspace trust ダイアログを自動応答で越えるため見ない。
   */
  trustPaths?: readonly string[];
}

/** pty env を組み立てるための入力。 */
export interface BackendEnvInput {
  /** このエビの id（EBI_ID として子 MCP へ渡る値）。env 既定の組み立てに使う backend 用。 */
  agentId?: string | null;
  /** notification 注入モードが有効か。 */
  notifyMode?: boolean;
  /**
   * 制御MCP（ebi-control）の設定ファイルパス（claude 方言の JSON）。null なら制御MCP なし。
   * gemini は「引数ではなく env（GEMINI_CLI_SYSTEM_SETTINGS_PATH）」で MCP を渡すため、
   * buildArgs だけでなく buildEnv からもこの情報が要る（PR-C で追加）。
   */
  mcpConfigPath?: string | null;
  /**
   * 役割注入プロンプト。claude は `--append-system-prompt`（引数）で渡すが、gemini には
   * 相当フラグが無く per-エビ GEMINI.md 経由で渡すため、buildEnv 側でも必要（PR-C で追加）。
   */
  systemPrompt?: string | null;
  /**
   * TUI をインライン描画させる既定 env を敷くか（env EBI_INLINE_TUI の解決結果）。
   * false でも「起動に必須な env」（gemini の system settings パス等）は落としてはならない。
   * 何を落として何を残すかは各 backend の buildEnv が判断する。未指定は true 扱い。
   */
  inlineTui?: boolean;
}

/** 起動フェーズに出る対話ダイアログ（ゲート）の種別。 */
export type StartupGateKind = "devChannels" | "trust";

/**
 * 起動ゲートの検出＋自動応答の定義。バックエンドごとに文言もフローも違うため、
 * Agent（PTY 管理）側は「spec に聞く」だけにして固有文言を持たない。
 */
export interface StartupGateSpec {
  /** このバックエンドが出しうるゲート種別の全集合（全部応答済みなら走査を打ち切る）。 */
  readonly kinds: readonly StartupGateKind[];
  /** 自動応答を許可する値の組込み許可リスト（正確値・完全一致）。 */
  readonly baseAllowlist: readonly string[];
  /**
   * ready 昇格をブロックするゲート種別。
   * このゲートへ応答するまで ready にしない（ダイアログの沈黙で ready 誤昇格するのを防ぐ）。
   * null なら ready 判定をブロックしない。
   */
  readonly readyBlockingGate: StartupGateKind | null;
  /** 起動引数を見て、このエビで自動応答を有効化してよいかを判定する純関数。 */
  isAutoAnswerEligible(args: readonly string[], allowlist: readonly string[]): boolean;
  /** ANSI 除去済みの走査バッファからゲート種別を判定する純関数。 */
  detect(plainScanBuffer: string): StartupGateKind | null;
  /** ゲート検知時に PTY へ書き込む応答文字列。 */
  answerFor(kind: StartupGateKind): string;
  /** 自動応答したことをサーバログ / notice に残すための文言。 */
  noticeFor(kind: StartupGateKind): string;
}

/**
 * 制御MCP（ebi-control）の起動情報のバックエンド中立表現（SoT）。
 * ここから claude(--mcp-config JSON) / codex(-c TOML) / gemini(system settings JSON) の
 * 3 方言へ射影する（backends/mcpSpec.ts の純関数群）。
 */
export interface ControlMcpSpec {
  /** MCP サーバ名（mcpServers のキー / codex の mcp_servers.<name>）。 */
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

/**
 * 起動前チェック（preflight）の宣言的定義。
 *
 * 「何を確認するか」だけをデータで持ち、実際の I/O（コマンド実行・ファイル存在確認）は
 * 呼び出し側が行う。判定そのものは preflight.ts の純関数 evaluatePreflight() が担う
 * （＝単体テストでプロセスを起動せずに全分岐を固定できる）。
 */
export interface BackendPreflightSpec {
  /** バージョン確認に使う引数（例: ["--version"]）。空なら実行しない。 */
  readonly versionArgs: readonly string[];
  /**
   * 検証済みバージョン（PoC で実測した値）。null なら未固定。
   * 一致しない場合は **エラーにせず警告**にする（CLI の自動更新で簡単に動くため。R6 対策）。
   */
  readonly verifiedVersion: string | null;
  /**
   * 存在が必須のファイル（認証情報など）。先頭 "~/" はホームへ展開する。
   * 例: codex="~/.codex/auth.json" / gemini="~/.gemini/oauth_creds.json"
   */
  readonly requiredFiles: readonly string[];
  /**
   * 値が「ある」ことが必須の env キー。
   * 例: gemini の GOOGLE_CLOUD_PROJECT（Workspace アカウントでは無いと起動不能。
   * 設計書 §2.5 の deny 方針とは**逆向き**である点に注意。PoC 実測で確定）。
   */
  readonly requiredEnv: readonly string[];
  /**
   * 追加の実行チェック（PR-D で追加・任意項目）。
   * ファイルの存在だけでは分からない「実際にログインできているか」を CLI に聞く
   * （codex は `~/.codex/auth.json` があってもトークン失効で未ログインになりうる）。
   * 出力（stdout+stderr）が okPattern に一致しなければ **error**（spawn を止める）。
   */
  readonly loginCheck?: {
    readonly args: readonly string[];
    readonly okPattern: RegExp;
  } | null;
}

/**
 * バックエンドの「性質」だけを切り出したもの（起動引数の組み立てを含まない）。
 * PR-C / PR-D が実装本体を書く前に、PoC で判明した固有事情をデータとして先に置けるようにする
 * （profiles.ts が BackendId ごとの唯一の SoT）。
 */
export interface BackendTraits {
  /**
   * pty env から**削除する**キー（課金経路・別認証への誤接続を防ぐ）。
   * 親 env の継承分にだけ効かせる（ebi-team 自身が渡す launch.env は対象外）。
   * claude は空。
   */
  readonly envDenyList: readonly string[];
  /**
   * statusLine 相当で usage（cost / context）を報告できるか。
   * false のバックエンドは UI に「—（未対応）」と明示表示する（空欄にしない）。
   */
  readonly reportsUsage: boolean;
  /**
   * idle 判定しきい値の上書き（ms）。null ならサーバ既定（EBI_IDLE_MS・既定 900）を使う。
   * PoC 実測では codex / gemini とも待機中の出力が 0 バイトで、上書きは不要（= null）。
   */
  readonly idleThresholdMs: number | null;
  /**
   * kill 時にプロセスグループごと落とす必要があるか。
   * gemini は子 node を再 exec するため PTY リーダの kill だけでは孤児が残る（PoC 実測）。
   * claude は false（現状踏襲）。実際の kill 実装の切替は PR-C で行う。
   */
  readonly killProcessGroup: boolean;
  /**
   * ready 到達前に予期せず exit した場合、1 回だけ再 spawn するか（PR-C で追加・任意項目）。
   * gemini は起動に外部条件（OAuth トークンの再取得・GCP 側の応答）が絡み、稀に起動途中で
   * 落ちうるため true。claude / codex は false（未指定＝false）。
   */
  readonly retryOnEarlyExit?: boolean;
  /** 起動前チェックの宣言。 */
  readonly preflight: BackendPreflightSpec;
  /**
   * 初回タスクを起動引数として渡す形。
   * claude: []（対話起動では渡さない・従来どおり注入）
   * codex:  [prompt]（位置引数）
   * gemini: ["-i", prompt]
   */
  initialPromptArgs(prompt: string): string[];
}

/** 1 つのエージェント CLI バックエンドの振る舞い定義。 */
export interface EbiBackend extends BackendTraits {
  readonly id: BackendId;
  /** 既定バイナリ名（config / env で上書き可）。 */
  readonly defaultCommand: string;
  /** このバックエンドのコマンドか（コマンド名 or パス末尾で判定）。 */
  matches(command: string): boolean;
  /** 起動引数を組み立てる純関数（外形ゼロ差分を担保すべき主戦場）。 */
  buildArgs(input: BackendLaunchInput): string[];
  /**
   * pty env の「既定値」（親 env より低い優先度で敷かれる）。
   * インライン TUI 描画のための env 等。CLI フラグで済むバックエンドは空を返してよい。
   */
  buildEnv(input?: BackendEnvInput): Record<string, string>;
  /**
   * master→エビ の notification（channel）注入に対応するか。
   * false のバックエンドは配送が自動的に PTY 注入経路へ落ちる。
   */
  readonly supportsChannelInject: boolean;
  /** この起動引数/env が ebi-control MCP ブリッジを持つか（= notification 購読が期待できるか）。 */
  hasControlBridge(args: readonly string[], env?: Record<string, string>): boolean;
  /** 起動ゲート（信頼ダイアログ等）の定義。出さないバックエンドは null。 */
  readonly startupGates: StartupGateSpec | null;
  /**
   * 「入力受付（プロンプト表示）」を示す出力パターン（PR-C で追加・任意項目）。
   *
   * 既定の ready 判定は「boot 猶予経過 ＋ 初めて idle」というヒューリスティックだが、
   * これは**沈黙するダイアログ**（gemini の OAuth トークン再取得中の
   * "Waiting for authentication..." 等）を ready と誤判定し、注入した本文が食われる。
   * このパターンを持つ backend は、**素文にこのパターンが現れるまで ready へ昇格しない**。
   * null / 未指定なら従来どおり（claude は現状踏襲）。
   */
  readonly readyPattern?: RegExp | null;
  /**
   * 起動フェーズに出たら「このまま待っても無駄」と分かる致命エラーの文言（PR-C で追加・任意項目）。
   * 検出したら notice / サーバログへ人間に分かる文言で流す（黙って ready 待ちタイムアウトさせない）。
   */
  readonly fatalPatterns?: readonly { readonly pattern: RegExp; readonly message: string }[];
  /** 初回タスクをコマンドの位置引数として渡せるか（渡せると注入タイミング問題が消える）。 */
  readonly supportsInitialPrompt: boolean;
  /**
   * ready 到達後に一度だけ PTY 注入する本文（未実装なら注入しない）。
   * `--append-system-prompt` 相当を持たないバックエンド（codex）が、役割プロンプトを
   * 「MCP 起動完了後の 1 通目」として送るために使う（位置引数で渡すと MCP 起動と競合する）。
   */
  initialInjectText?(input: BackendLaunchInput): string | null;
  /**
   * ready 昇格を遅らせる追加の猶予(ms)。boot 猶予（MIN_BOOT_MS）に**加算**される。
   * 「TUI は入力を受け付けるが、MCP ツールの登録がまだ終わっていない」時間帯に 1 通目を
   * 投げてしまうと、エビはツール無しでターンを開始する（reply_to_master が使えないまま
   * チャットに答えて終わる＝静かな故障）。未指定なら 0（従来どおり）。
   */
  readonly readyWarmupMs?: number;
}
