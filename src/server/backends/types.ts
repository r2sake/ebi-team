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

/** バックエンド識別子。実装済みかどうかは別（IMPLEMENTED_BACKEND_IDS を参照）。 */
export type BackendId = "claude" | "codex";

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
}

/** pty env を組み立てるための入力。 */
export interface BackendEnvInput {
  /** このエビの id（EBI_ID として子 MCP へ渡る値）。env 既定の組み立てに使う backend 用。 */
  agentId?: string | null;
  /** notification 注入モードが有効か。 */
  notifyMode?: boolean;
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

/** 1 つのエージェント CLI バックエンドの振る舞い定義。 */
export interface EbiBackend {
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
  /** 初回タスクをコマンドの位置引数として渡せるか（渡せると注入タイミング問題が消える）。 */
  readonly supportsInitialPrompt: boolean;
}
