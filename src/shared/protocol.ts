// ebi-team の WebSocket プロトコル定義（クライアント↔サーバ共通）。
// クライアント/サーバの双方が import するため、ランタイム依存を持たない型のみを置く。

/**
 * inject の送信先に指定すると「全エビへ一斉注入（ブロードキャスト）」になる sentinel。
 * agent id は `ebi-N` 採番なので衝突しない。型のみの方針の例外だが、
 * client/server 双方で同じ値を使う必要があるためここに置く。
 *
 * 注: UI の @mention 注入欄は廃止したが、制御API `/control/inject`（master が MCP の
 * inject_message で `to:"all"` 一斉注入に使う）と registry.resolveAndInject は引き続き
 * この sentinel を使うため、定義はサーバ側で残す。
 */
export const BROADCAST_TARGET = "all";

/** agent（エビ）の稼働状態。 */
export type AgentStatus = "idle" | "busy";

/**
 * エビの種別。
 * - master: エビチーム最高責任者（削除不可・常駐・Opus）。Discord/Slack 等の MCP は排除。
 * - supervisor: 監督・要約担当（削除不可・常駐・Haiku）。
 * - dynamic: 従来どおり追加/削除できる動的エビ（engineer 等）。既定値。
 */
export type AgentKind = "master" | "supervisor" | "dynamic";

/**
 * agent の接続モード。
 * - connected: 親プロセス/他 agent と疎通する想定（MVP は常にこれ）
 * - isolated: 隔離（次弾で worktree と組み合わせて使う想定）
 */
export type AgentMode = "connected" | "isolated";

/**
 * viewer（md/txt プレビュー）の表示フォーマット。
 * - md: 軽量 markdown レンダラで整形表示（見出し/箇条書き/コード/表 等）。
 * - txt: 生テキストを等幅で表示（.txt はレンダリングしない）。
 */
export type ViewerFormat = "md" | "txt";

/**
 * viewer（読み取り専用の md/txt プレビュー）1 件分のスキーマ。
 * プロセスを持たない UI エンティティで、AgentRecord とは別のコレクション
 * （src/server/viewerRegistry.ts）でサーバが保持する。master が open_viewer で開く。
 * content は open 時点のスナップショット（読み取り専用・以後追従しない）。
 */
export interface ViewerRecord {
  /** viewer id（`viewer-N` 採番。agent id とは名前空間が別）。 */
  id: string;
  /** 開いた元ファイルの絶対パス（表示・ツールチップ用）。 */
  path: string;
  /** 表示タイトル（未指定時はファイル名）。 */
  title: string;
  /** レンダリング形式（拡張子から判定）。 */
  format: ViewerFormat;
  /** ファイル内容（open 時点のスナップショット・UTF-8）。 */
  content: string;
}

/** registry に保持する agent 1件分のスキーマ。 */
export interface AgentRecord {
  id: string;
  cwd: string;
  /** git ブランチ名。MVP では null 固定でよい。 */
  branch: string | null;
  status: AgentStatus;
  mode: AgentMode;
  /** spawn したプロセスの pid。spawn 前は null。 */
  pid: number | null;
  /** エビ種別（master/supervisor/dynamic）。既定 dynamic。 */
  kind: AgentKind;
  /**
   * 固定エビ（削除不可）か。master/supervisor は true。
   * true の agent は kill をサーバ側で拒否し、自動再起動の対象になる。
   */
  pinned: boolean;
  /** 起動に使ったモデル（表示用。alias または full ID。未指定 spawn なら null）。 */
  model: string | null;
  /**
   * 動的エビの役割（roles.ts の EBI_ROLES の id。既定同梱は engineer）。
   * 素の dynamic spawn（役割なし）や固定エビ（master/supervisor）では null。
   * UI のバッジ表示に使う（kind は増やさず role で種別を表す）。
   */
  role?: string | null;
}

// ===== クライアント → サーバ =====

/** agent を新規 spawn する。 */
export interface SpawnMessage {
  type: "spawn";
  /** 作業ディレクトリ。未指定ならサーバ既定。worktree 有効時は無視され、生成された worktree パスが使われる。 */
  cwd?: string;
  /** id を明示したい場合（省略時はサーバ採番）。 */
  id?: string;
  /** true なら git worktree を切って隔離 cwd で起動する。 */
  useWorktree?: boolean;
  /** worktree の元になる git repo パス。未指定なら cwd（無ければサーバ既定）を repo とみなす。 */
  repoPath?: string;
  /** 生成する（または再利用する）ブランチ名。未指定なら `ebi/<agent-id>` を採番。 */
  branch?: string;
}

/** agent を kill して registry から除去する。 */
export interface KillMessage {
  type: "kill";
  id: string;
}

/** ペインからの生キー入力を対象 agent の stdin へ書き込む。 */
export interface InputMessage {
  type: "input";
  id: string;
  data: string;
}

/** ペインのリサイズを対象 PTY へ反映する。 */
export interface ResizeMessage {
  type: "resize";
  id: string;
  cols: number;
  rows: number;
}

/** 現在の registry 一覧を要求する。 */
export interface ListMessage {
  type: "list";
}

/**
 * agent の接続モード（connected/isolated）を切り替える。
 * isolated にすると @all ブロードキャストや他 agent 由来の単体注入を受けなくなる。
 */
export interface SetModeMessage {
  type: "setMode";
  id: string;
  mode: AgentMode;
}

/**
 * 指定 agent の output 購読を開始する。
 * この WS 接続には、購読中の agent の `output` のみが配信される。
 * `ids` 指定で複数まとめて購読できる（`id` 単体指定も可）。
 */
export interface SubscribeMessage {
  type: "subscribe";
  id?: string;
  ids?: string[];
}

/** 指定 agent の output 購読を解除する。 */
export interface UnsubscribeMessage {
  type: "unsubscribe";
  id?: string;
  ids?: string[];
}

/**
 * 対象 agent の直近スクロールバックを Haiku でオンデマンド要約する。
 * 監督機能（既定 OFF）が有効なときだけクライアントから送られる。
 * サーバは要約結果を `summary` で返す（失敗時は `notice`）。
 */
export interface SummarizeMessage {
  type: "summarize";
  id: string;
}

/**
 * viewer を閉じる（クライアント → サーバ）。
 * viewer はプロセスを持たないため kill 意味論は使わず、専用の close 経路にする。
 * サーバは viewerRegistry.close(id) 後に `viewers` を再 broadcast する。
 */
export interface CloseViewerMessage {
  type: "closeViewer";
  id: string;
}

export type ClientMessage =
  | SpawnMessage
  | KillMessage
  | InputMessage
  | ResizeMessage
  | ListMessage
  | SetModeMessage
  | SubscribeMessage
  | UnsubscribeMessage
  | SummarizeMessage
  | CloseViewerMessage;

// ===== サーバ → クライアント =====

/** registry の全件スナップショット。状態変化のたびに配信。 */
export interface RegistryMessage {
  type: "registry";
  agents: AgentRecord[];
}

/** 指定 agent の PTY 出力チャンク。 */
export interface OutputMessage {
  type: "output";
  id: string;
  data: string;
}

/**
 * 再アタッチ用スクロールバック。subscribe 初回時に、その接続へ
 * リングバッファの内容を一括送信するために使う。
 * 順序保証: この scrollback を全部送ってから以降の live `output` を流す。
 * クライアントは受信したら xterm に write して画面を復元する。
 */
export interface ScrollbackMessage {
  type: "scrollback";
  id: string;
  data: string;
}

/** agent が spawn された通知（registry も別途飛ぶ）。 */
export interface SpawnedMessage {
  type: "spawned";
  agent: AgentRecord;
}

/** agent が終了/除去された通知。 */
export interface ExitedMessage {
  type: "exited";
  id: string;
  /** プロセス終了コード（kill 等で不明なら null）。 */
  exitCode: number | null;
}

/** 単一 agent の status 変化通知。 */
export interface StatusMessage {
  type: "status";
  id: string;
  status: AgentStatus;
}

/** 注入がキューに積まれた/flush された等の情報通知。 */
export interface NoticeMessage {
  type: "notice";
  id: string;
  text: string;
}

/** エラー通知。 */
export interface ErrorMessage {
  type: "error";
  text: string;
}

/**
 * `summarize` に対する Haiku 要約結果（監督機能・既定 OFF）。
 * text は日本語の短い要約（3〜5行想定）。
 */
export interface SummaryMessage {
  type: "summary";
  id: string;
  text: string;
}

/**
 * サーバ起動時の能力（capabilities）通知。接続直後に 1 度だけ送る。
 * クライアントは supervisor が true のときだけ「要約」UI を出す。
 */
export interface CapabilitiesMessage {
  type: "capabilities";
  /** 監督・要約機能が有効か（＝サブスクの claude CLI が使えるか）。 */
  supervisor: boolean;
}

/** ダッシュボード: エビ 1 体分の使用状況（cost/context/model）。 */
export interface UsageAgent {
  /** エビ id（EBI_ID）。 */
  id: string;
  /** モデル表示名（statusLine の model.display_name、無ければ id）。 */
  model: string | null;
  /** 推定コスト（USD）。Max は実質サブスク内・実請求とは別の「推定」値。 */
  costUsd: number | null;
  /** context window 使用率（%）。 */
  contextUsedPct: number | null;
  /** context window 全体サイズ（トークン）。 */
  contextSize: number | null;
  /** トークン内訳（直近の current_usage）。 */
  tokens: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheCreation: number | null;
  };
  /** このエビの usage を最後に受信した時刻（epoch ms）。 */
  updatedAt: number;
}

/** ダッシュボード: アカウント単位のレート制限（全エビ共通）。 */
export interface UsageRateLimits {
  /** 5 時間枠。未受信なら null。 */
  fiveHour: { usedPct: number; resetsAt: number } | null;
  /** 7 日枠。未受信なら null。 */
  sevenDay: { usedPct: number; resetsAt: number } | null;
}

/**
 * 使用状況スナップショット。接続直後に現在値を 1 度送り、`/control/usage` 受信のたびに
 * broadcast する。cost はあくまで「推定」（Max サブスクの実請求とは別）。
 */
export interface UsageMessage {
  type: "usage";
  agents: UsageAgent[];
  rateLimits: UsageRateLimits;
  /** 全エビの推定コスト合計（USD）。 */
  totalCostUsd: number;
}

/**
 * viewer コレクションの全件スナップショット（サーバ → クライアント）。
 * 接続直後に 1 度、および open/close のたびに broadcast する。
 * クライアントは registry サイドバーに viewer 行を合成表示し、選択でパネル表示する。
 */
export interface ViewersMessage {
  type: "viewers";
  viewers: ViewerRecord[];
}

export type ServerMessage =
  | RegistryMessage
  | OutputMessage
  | ScrollbackMessage
  | SpawnedMessage
  | ExitedMessage
  | StatusMessage
  | NoticeMessage
  | ErrorMessage
  | SummaryMessage
  | CapabilitiesMessage
  | UsageMessage
  | ViewersMessage;
