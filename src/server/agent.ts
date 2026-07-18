import * as pty from "node-pty";
import { IdleDetector } from "./idleDetector.ts";
import type { AgentRecord, AgentStatus, AgentMode, AgentKind } from "../shared/protocol.ts";

/**
 * 注入時、本文を書いてから Enter(`\r`) を別 write で送るまでの待ち時間(ms)。
 * claude TUI は一括入力をペースト扱いし、本文と同一 write の末尾 `\r` を「改行」と解釈して
 * 送信されない。本文と Enter を時間的に分離し、Enter を独立キー入力として届けて確実に送信する。
 * env `EBI_ENTER_DELAY_MS` で調整可（遅い環境で送信されない場合は増やす）。
 */
const ENTER_DELAY_MS = Number(process.env.EBI_ENTER_DELAY_MS) || 500;

/**
 * spawn 後、「TUI が入力受付（ready）になった」と判定するまでの最小 boot 猶予(ms)。
 * claude TUI は起動直後に初期化のための出力で busy になるため、起動時刻から
 * この猶予を経過し、かつ初めて idle に達したら ready とみなす（ヒューリスティック）。
 * env `EBI_MIN_BOOT_MS` で調整可（bash 等の軽い command やテストでは小さく下げられる）。
 */
const MIN_BOOT_MS = Number(process.env.EBI_MIN_BOOT_MS) || 1500;

/**
 * [B] idle 自動通知の抑制窓(ms)。直近この時間内に [A] の明示リプライ（reply_to_master）が
 * あったエビは、その直後の idle では B（idle 自動通知）を出さない。
 * 「A を呼んだら B は黙る／呼び忘れたら B が拾う」を成立させるための窓。
 * env `EBI_REPLY_SUPPRESS_MS` で調整可。
 */
const REPLY_SUPPRESS_MS = Number(process.env.EBI_REPLY_SUPPRESS_MS) || 5000;

/**
 * 起動ゲート自動応答を許可する dev channel 値の「組込み（既定）許可リスト」。
 * ここに載っている**正確値**（完全一致）だけを自動応答対象にする。
 * ワイルドカード・前方一致・部分一致は一切しない（意図せぬ承認を防ぐ）。
 * 運用者が config（ebi-team.config.json の top-level "devChannelsAllowlist"）で
 * 追加の正確値を足せる（例: 外部チャンネル待機セッションの plugin:slack@<marketplace>）。
 * その追加分は index.ts が SpawnConfig.devChannelsAllowlist にマージして Agent に渡す。
 */
export const BASE_ALLOWED_DEV_CHANNELS: readonly string[] = ["server:ebi-control"];

/**
 * 起動ゲート（trust / dev-channels 警告）自動応答を受け付ける「起動フェーズ」の時間窓(ms)。
 * spawn からこの時間内に出たダイアログにだけ応答する。
 * 注意: これらダイアログはセッションを入力待ちで沈黙させ、その沈黙を idle 検出器が拾って
 * hasBeenReady を立ててしまうため、ready フラグでは窓を判定できない（沈黙＝ready 誤昇格）。
 * よって spawn 時刻からの経過時間で「起動フェーズ限定」を担保する。dialog は spawn 後
 * 数秒で出るので十分広めに取る。env `EBI_GATE_WINDOW_MS` で調整可。
 */
const GATE_WINDOW_MS = Number(process.env.EBI_GATE_WINDOW_MS) || 90000;

/**
 * spawn 引数を見て「起動ゲート（trust / dev-channels 警告）の自動応答を有効化してよいか」を判定する。
 *
 * 安全限定（正確値の許可リスト方式）: `--dangerously-load-development-channels` の値が
 * **1個以上あり、そのすべてが `allowlist` の正確値（完全一致）である**ときだけ true。
 * 許可リストに無い値が1つでも混ざる／フラグ自体が無い場合は false
 * （＝自動で危険確認を承認しない。設定書き換えによる意図せぬ承認を防ぐ）。
 * 照合は完全一致のみ。ワイルドカード・前方一致・部分一致は一切導入しない
 * （`plugin:slack@*` のような値は許可リストに正確一致しない限り必ず false）。
 *
 * `allowlist` 未指定時は組込みの BASE_ALLOWED_DEV_CHANNELS（server:ebi-control のみ）を使う。
 * 当該フラグは variadic（`<servers...>`）で、次の `--flag` までの全トークンを値として取る。
 */
export function isDevChannelsAutoAnswerEligible(
  args: readonly string[],
  allowlist: readonly string[] = BASE_ALLOWED_DEV_CHANNELS,
): boolean {
  const flagIdx = args.indexOf("--dangerously-load-development-channels");
  if (flagIdx === -1) return false;
  const values: string[] = [];
  for (let i = flagIdx + 1; i < args.length; i++) {
    if (args[i].startsWith("--")) break;
    values.push(args[i]);
  }
  // 値が1個以上あり、そのすべてが許可リストに完全一致することを要求する。
  return values.length >= 1 && values.every((v) => allowlist.includes(v));
}

/**
 * 起動フェーズの対話ダイアログ種別を、素文スキャンバッファから判定する純関数。
 *
 * claude(Ink) TUI は単語間を空白でなくカーソル移動エスケープで描画するため、ANSI 除去後は
 * "Iamusingthisforlocaldevelopment" のように空白が消えることがある（TUI が空白なしで
 * 描画する既知の罠）。よって照合は**空白を全除去した文字列**に対して**空白なしパターン**で行う。
 * これにより空白あり／なしどちらの描画でも同じく検知できる。
 *
 * 戻り値:
 *  - "devChannels": development channels 警告（--dangerously-load-development-channels 使用時）
 *  - "trust": workspace trust 確認（初見 cwd）
 *  - null: どちらのダイアログも検知できない
 */
export function detectStartupGate(rawScanBuffer: string): "devChannels" | "trust" | null {
  const compact = rawScanBuffer.replace(/\s+/g, "");
  if (/Loadingdevelopmentchannels|localchanneldevelopment|Iamusingthisforlocaldevelopment/i.test(compact)) {
    return "devChannels";
  }
  if (/trustthisfolder|Isthisaprojectyou(created|trust)/i.test(compact)) {
    return "trust";
  }
  return null;
}

/**
 * [B] idle 自動通知の per-agent クールダウン(ms)。同一エビが busy→idle を繰り返しても、
 * この時間内は B を 1 回しか出さない（master への通知洪水を防ぐ）。
 * env `EBI_IDLE_NOTIFY_COOLDOWN_MS` で調整可。
 */
const IDLE_NOTIFY_COOLDOWN_MS = Number(process.env.EBI_IDLE_NOTIFY_COOLDOWN_MS) || 30000;

/**
 * [B] idle 自動通知の全体 on/off。env `EBI_IDLE_NOTIFY` が "off"/"0"/"false" のとき無効。
 * 既定 on（保険として動かす）。
 */
const IDLE_NOTIFY_ENABLED = !["off", "0", "false"].includes(
  (process.env.EBI_IDLE_NOTIFY ?? "on").toLowerCase(),
);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** spawn する対象コマンドの設定（サーバ全体の既定値）。 */
export interface SpawnConfig {
  /** 起動するシェル/バイナリ（既定は "claude"）。 */
  command: string;
  /** 引数（claude はインタラクティブ起動のため通常は空）。 */
  args: string[];
  /** idle 判定のしきい値（ms）。 */
  idleThresholdMs: number;
  /**
   * 再アタッチ用スクロールバックのリングバッファ上限（バイト相当）。
   * PTY 出力をこのバイト数まで保持し、超過分は古い方から捨てる。
   */
  scrollbackBytes: number;
  /**
   * 起動ゲート自動応答を許可する dev channel 値の許可リスト（正確値・完全一致）。
   * 組込みの BASE_ALLOWED_DEV_CHANNELS ＋ config（devChannelsAllowlist）由来の追加値。
   * index.ts が起動時に組み立てて渡す（未指定時は BASE を使う）。
   */
  devChannelsAllowlist?: string[];
}

/**
 * 1 体のエビを起動するための実パラメータ束。
 * 固定エビは config から、動的エビはサーバ既定（SpawnConfig）から構築する。
 * すべて execFile 同様の引数配列方式で node-pty に渡す（シェル非経由＝注入安全）。
 */
export interface LaunchParams {
  /** 起動バイナリ（既定 "claude"。テスト時は "bash" 等に差し替え可）。 */
  command: string;
  /**
   * 起動引数の最終形。
   * `--model` / `--append-system-prompt` / `--permission-mode` / 任意 args を
   * すべて展開済みの配列として渡す（呼び出し側で組み立てる）。
   */
  args: string[];
  /** 作業ディレクトリ。 */
  cwd: string;
  /** 表示用モデル名（alias/full ID。未指定なら null）。 */
  model: string | null;
  /**
   * pty に注入する追加 env（親 env にマージ。同名キーは上書き）。
   * engineer エビに `EBI_ID=<id>` を渡し、その子プロセスが起動する stdio MCP
   * （control-server）の reply_to_master が「自分の id」を from に入れられるようにする。
   * 未指定なら親 env をそのまま使う。
   */
  env?: Record<string, string>;
}

/** Agent からのイベントを購読するためのコールバック束。 */
export interface AgentHandlers {
  onData: (id: string, data: string) => void;
  onStatus: (id: string, status: AgentStatus) => void;
  onExit: (id: string, exitCode: number | null) => void;
  onNotice: (id: string, text: string) => void;
  /**
   * [B] idle 自動通知フック（任意）。busy→idle のエッジで、master/supervisor 以外かつ
   * ready 済みのエビが「直近に A の明示リプライが無く・クールダウンも超えている」場合に呼ばれる。
   * index.ts 側で registry.reverseInject(id, "master", "...", "idle") を発火させる配線に使う。
   */
  onIdleNotify?: (id: string) => void;
}

/**
 * 1つの agent（エビ）= node-pty で直 spawn した claude プロセス。
 * 注入キューと idle/busy 判定を内包する。
 */
export class Agent {
  readonly id: string;
  readonly cwd: string;
  branch: string | null = null;
  mode: AgentMode = "connected";
  pid: number | null = null;
  /** 直近の端末行数（spawn 既定 24・resize で更新）。端末カーソル位置クエリ応答に使う。 */
  private rows = 24;
  /** エビ種別。既定 dynamic。固定エビは spawn 時に master/supervisor を指定する。 */
  readonly kind: AgentKind = "dynamic";
  /** 固定エビ（削除不可）か。master/supervisor は true。 */
  readonly pinned: boolean = false;
  /** 動的エビの役割（roles.ts の EBI_ROLES id）。役割なし spawn / 固定エビは null。 */
  readonly role: string | null = null;
  /**
   * notification（mailbox 購読）経路で受信するか。既定 true。
   * false のエビは「受信を PTY 注入に固定」する（外部チャンネル待機セッション minaebi 等、
   * 自セッションに ebi-control channel を登録しない＝notification が harness に黙って捨てられる
   * ものに対し、送信側が購読確立を待たず即 PTY で届けるための印）。config の
   * fixedEbi[].notifySubscribe:false → SpawnOptions 経由で設定される。
   */
  readonly notifySubscribe: boolean = true;
  /** 表示用モデル名（alias/full ID）。未指定 spawn なら null。 */
  readonly model: string | null = null;
  /**
   * 起動に使った実パラメータ。自動再起動（固定エビ）でそのまま再 spawn するために保持する。
   */
  readonly launch: LaunchParams;
  /**
   * worktree 由来 agent の場合の内部メモ（registry の公開フィールドには出さない）。
   * kill 時のクリーンアップ（git worktree remove）で使う。worktree でなければ null。
   */
  worktreeRepo: string | null = null;
  worktreePath: string | null = null;

  private readonly proc: pty.IPty;
  private readonly detector: IdleDetector;
  private readonly handlers: AgentHandlers;
  /** busy 中に保留された注入文字列（送信フォーマット済み・末尾改行付き）。 */
  private readonly injectQueue: string[] = [];
  private disposed = false;

  // ===== readiness（ready 判定）=====
  // 「claude TUI が入力受付になった」をヒューリスティックで判定する。
  // spawn 時刻から MIN_BOOT_MS を経過し、かつ初めて idle に達したら ready とみなす。
  // 一度 ready になったら以降ずっと ready（後戻りしない）。
  /** プロセス起動時刻（ready 判定の boot 猶予計算に使う）。 */
  private readonly spawnedAt: number = Date.now();
  /** これまでに一度でも ready に達したか。 */
  private hasBeenReady = false;
  /** ready 化 or dispose を待つ waiter の resolve 関数（waitUntilReady 用）。 */
  private readonly readyWaiters: ((ready: boolean) => void)[] = [];
  /** boot 猶予満了時に ready 昇格を再評価するためのタイマ。 */
  private bootTimer: NodeJS.Timeout | null = null;

  // ===== 起動ゲート自動応答（workspace trust / development channels 警告）=====
  // notification 注入（EBI_INJECT_MODE=notify）で ebi-control を dev channel として使うと、
  // spawn した claude が起動時に2種の対話ダイアログを出して入力待ちで固まる:
  //  - workspace trust（初見 cwd）: "Yes, I trust this folder"
  //  - development channels 警告（--dangerously-load-development-channels 使用時）:
  //    "I am using this for local development"
  // 無人 spawn を止めないよう、起動フェーズ（spawn からの時間窓）に限りこれらへ "1\r" を自動応答する。
  // 【安全限定】自動応答は「spawn 引数の --dangerously-load-development-channels の値が
  //  server:ebi-control ちょうど1個」の場合のみ有効化する（別サーバ名・複数指定が混ざったら
  //  自動応答しない＝設定書き換えによる意図せぬ承認を防ぐ）。運用者の承認のもと有効化。
  /** この agent で起動ゲート自動応答を有効化してよいか（上記の安全限定を満たすか）。 */
  private readonly autoAnswerStartupGates: boolean;
  /** workspace trust ダイアログへ既に応答したか（多重送信防止）。 */
  private trustGateAnswered = false;
  /** development channels 警告へ既に応答したか（多重送信防止）。 */
  private devChannelsGateAnswered = false;
  /** ダイアログはチャンクを跨いで描画されるため、ready 前の出力を素文で溜めて走査する（上限付き）。 */
  private gateScanBuffer = "";

  // ===== 逆方向通知（reverse-notify）の抑制状態 =====
  /** [A] 直近に reply_to_master（kind:"reply"）を発した時刻。B の抑制判定に使う。0 は未発。 */
  private lastReplyAt = 0;
  /** [B] 直近に idle 自動通知を発火した時刻。per-agent クールダウン判定に使う。0 は未発。 */
  private lastIdleNotifyAt = 0;

  // ===== 再アタッチ用スクロールバック（上限付きリングバッファ）=====
  // PTY 出力チャンクを到着順に保持し、UTF-8 バイト換算の合計が上限を超えたら
  // 古いチャンクから丸ごと捨てる（チャンク境界で切るので multibyte を割らない）。
  // 上限を 0 以下にすると無効化（バッファしない）。
  private readonly scrollbackBytes: number;
  private readonly scrollbackChunks: string[] = [];
  private scrollbackSize = 0;

  constructor(
    id: string,
    launch: LaunchParams,
    config: Pick<SpawnConfig, "idleThresholdMs" | "scrollbackBytes" | "devChannelsAllowlist">,
    handlers: AgentHandlers,
    opts?: { kind?: AgentKind; pinned?: boolean; role?: string | null; notifySubscribe?: boolean },
  ) {
    this.id = id;
    this.cwd = launch.cwd;
    this.launch = launch;
    this.model = launch.model;
    this.kind = opts?.kind ?? "dynamic";
    this.pinned = opts?.pinned ?? false;
    this.role = opts?.role ?? null;
    this.notifySubscribe = opts?.notifySubscribe ?? true;
    this.handlers = handlers;
    this.scrollbackBytes = config.scrollbackBytes;
    this.autoAnswerStartupGates = isDevChannelsAutoAnswerEligible(
      launch.args,
      config.devChannelsAllowlist ?? BASE_ALLOWED_DEV_CHANNELS,
    );

    this.detector = new IdleDetector(
      config.idleThresholdMs,
      () => this.onIdle(),
      () => this.onBusy(),
    );

    // 引数配列方式で起動（シェル非経由）。長文の --append-system-prompt も安全に渡る。
    // launch.env があれば親 env にマージする（engineer の EBI_ID 等。子の stdio MCP が継承する）。
    const spawnEnv = launch.env
      ? { ...(process.env as Record<string, string>), ...launch.env }
      : (process.env as { [key: string]: string });
    this.proc = pty.spawn(launch.command, launch.args, {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: launch.cwd,
      env: spawnEnv,
    });
    this.pid = this.proc.pid;

    this.proc.onData((data) => {
      // 端末クエリには best-effort で応答（待ちブロックの claude を解放するため）。
      this.answerTerminalQueries(data);
      // カーソル位置クエリ（DSR: ESC[6n / DECXCPR: ESC[?6n）は claude TUI が毎フレーム吐く
      // 常時プローブで「作業中の出力」ではない。これを除いた実出力がある時だけ busy 扱い・
      // scrollback 保持・ブラウザ配信の対象にする（連投で永遠 busy になる／scrollback が
      // ノイズで膨れる／ready 待ちがタイムアウトする問題を防ぐ）。
      const meaningful = data.replace(/\x1b\[\??6n/g, "");
      if (meaningful.length === 0) return;
      // 起動フェーズ（ready 前）の対話ダイアログへ自動応答（安全限定つき）。
      this.maybeAnswerStartupGates(meaningful);
      this.detector.notifyOutput();
      this.appendScrollback(meaningful);
      this.handlers.onData(this.id, meaningful);
    });

    this.proc.onExit(({ exitCode }) => {
      this.detector.dispose();
      // exit 時は ready 待ちを false で解決し、dispose 状態に整える。
      this.disposed = true;
      if (this.bootTimer) {
        clearTimeout(this.bootTimer);
        this.bootTimer = null;
      }
      this.resolveReadyWaiters(false);
      this.handlers.onExit(this.id, exitCode);
    });

    // boot 猶予満了時に ready 昇格を再評価する（猶予前に idle 化して以降出力が来ない
    // ケースでも、満了後に idle なら ready へ昇格させる）。
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      this.promoteReadyIfEligible();
    }, MIN_BOOT_MS + 50);
  }

  getStatus(): AgentStatus {
    return this.detector.getStatus();
  }

  /** TUI が入力受付（ready）になったか。一度 ready なら以降ずっと true。 */
  isReady(): boolean {
    return this.hasBeenReady;
  }

  /**
   * [A] このエビが master へ明示リプライ（reply_to_master）を発したことを記録する。
   * registry.reverseInject(kind:"reply") から from エビに対して呼ばれ、直後の idle で
   * B（idle 自動通知）を抑制するための時刻を更新する。
   */
  markReplied(): void {
    this.lastReplyAt = Date.now();
  }

  /**
   * ready になるまで待つ。
   * - 既に ready なら即 resolve(true)。
   * - 未 ready なら ready 化（resolve(true)）または timeout（resolve(false)）まで待つ。
   * - dispose（kill/exit）時は resolve(false) で解決する。
   */
  waitUntilReady(timeoutMs: number): Promise<boolean> {
    if (this.hasBeenReady) return Promise.resolve(true);
    if (this.disposed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      // ready 化 or dispose で呼ばれる waiter 本体。
      const wrapped = (ready: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ready);
      };
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // タイムアウト分の waiter を取り除いてから false で解決する。
        const idx = this.readyWaiters.indexOf(wrapped);
        if (idx >= 0) this.readyWaiters.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      this.readyWaiters.push(wrapped);
    });
  }

  /** ready 化を待つ waiter を全て resolve(true) で解決する。 */
  private resolveReadyWaiters(ready: boolean): void {
    while (this.readyWaiters.length > 0) {
      const w = this.readyWaiters.shift()!;
      w(ready);
    }
  }

  /**
   * ready 条件（boot 猶予経過 ＆ idle 状態）を満たしていれば ready に昇格する。
   * onIdle から呼ばれるほか、boot 猶予前に idle へ達してしまい以降出力が来ない
   * ケースに備え、猶予満了タイマからも呼ぶ（出力停止後に確実に ready 化させる）。
   */
  private promoteReadyIfEligible(): void {
    if (this.disposed || this.hasBeenReady) return;
    if (Date.now() - this.spawnedAt < MIN_BOOT_MS) return;
    if (this.getStatus() !== "idle") return;
    this.hasBeenReady = true;
    this.handlers.onNotice(this.id, "ready（入力受付になりました）");
    this.resolveReadyWaiters(true);
  }

  /**
   * 再アタッチ用スクロールバックの現在内容を 1 本の文字列として返す。
   * subscribe 初回時にこれを接続へ一括送信してから live output を流す。
   */
  getScrollback(): string {
    return this.scrollbackChunks.join("");
  }

  /** PTY 出力チャンクをリングバッファに追記し、上限超過分を古い方から捨てる。 */
  private appendScrollback(data: string): void {
    if (this.scrollbackBytes <= 0 || data.length === 0) return;
    this.scrollbackChunks.push(data);
    this.scrollbackSize += Buffer.byteLength(data, "utf8");
    // 上限超過分を先頭（古い）から丸ごと捨てる。1 チャンクで上限超でも最低 1 件は残す。
    while (this.scrollbackSize > this.scrollbackBytes && this.scrollbackChunks.length > 1) {
      const dropped = this.scrollbackChunks.shift()!;
      this.scrollbackSize -= Buffer.byteLength(dropped, "utf8");
    }
  }

  /** ペインからの生キー入力を stdin へ書き込む。 */
  write(data: string): void {
    if (this.disposed) return;
    this.proc.write(data);
  }

  /** PTY をリサイズする。 */
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    if (cols > 0 && rows > 0) {
      this.rows = rows;
      this.proc.resize(cols, rows);
    }
  }

  /**
   * 端末ステータスクエリへ自動応答する。
   * claude(Ink) TUI は描画時に端末へカーソル位置を問い合わせる（DSR: ESC[6n / DECXCPR: ESC[?6n）。
   * ブラウザ(xterm.js)が未接続だと誰も応答せず、claude が応答待ちでクエリを連投し続け、
   * PTY 出力が止まらない＝永遠に busy（ready 待ちタイムアウト）になる。
   * サーバ（PTY 親）が標準応答を返してループを止め、headless でも自走できるようにする。
   * 位置は追跡していないので「最下行・左端」を返す（出力末尾にカーソルがある想定で描画事故を抑える）。
   */
  private answerTerminalQueries(data: string): void {
    if (this.disposed || data.indexOf("\x1b[") === -1) return;
    let reply = "";
    // DECXCPR（DEC カーソル位置）ESC[?6n -> ESC[?<row>;<col>R（xterm.js 実装と同形式）
    for (const _m of data.matchAll(/\x1b\[\?6n/g)) reply += `\x1b[?${this.rows};1R`;
    // DSR（カーソル位置）ESC[6n -> ESC[<row>;<col>R
    for (const _m of data.matchAll(/\x1b\[6n/g)) reply += `\x1b[${this.rows};1R`;
    if (reply) this.proc.write(reply);
  }

  /**
   * 起動フェーズ（ready 前）に出る対話ダイアログへ自動応答する。
   *
   * 対象は 2 種（いずれも選択肢 1＝許可 を選んで Enter）:
   *  - development channels 警告（`--dangerously-load-development-channels` 使用時に必ず出る）
   *  - workspace trust 確認（初見 cwd のとき出る）
   *
   * 発火条件（すべて満たすときのみ）:
   *  - `autoAnswerStartupGates`（spawn 引数の dev-channels 値が server:ebi-control ちょうど1個）
   *  - spawn からの時間窓 `GATE_WINDOW_MS` 内（起動フェーズ限定。ready フラグは沈黙で誤昇格
   *    するため使わない＝ダイアログ待ちの沈黙で ready 化しても応答できるようにする）
   *  - 当該ダイアログにまだ応答していない（多重送信防止）
   *
   * ダイアログはチャンクを跨いで届くため、素文（ANSI 除去）を上限付きバッファに
   * 溜めてから判定する。応答したら、どのダイアログへ何を送ったかをサーバログに残す。
   */
  private maybeAnswerStartupGates(chunk: string): void {
    if (this.disposed || !this.autoAnswerStartupGates) return;
    // 起動フェーズ限定（spawn からの時間窓）。ready フラグは沈黙で誤昇格するため使わない。
    if (Date.now() - this.spawnedAt > GATE_WINDOW_MS) return;
    if (this.trustGateAnswered && this.devChannelsGateAnswered) return;

    // ANSI/OSC を除去して素文にし、直近ぶんだけ保持（ダイアログ全文は数百字に収まる）。
    const plain = chunk
      .replace(/\x1b\][^\x07]*\x07/g, "")
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      .replace(/\x1b[()][A-Z0-9]/g, "");
    this.gateScanBuffer = (this.gateScanBuffer + plain).slice(-4096);
    // 空白なし照合は detectStartupGate（純関数）に集約している（TUI が空白なしで描画する罠に対応）。
    const gate = detectStartupGate(this.gateScanBuffer);

    // development channels 警告（許可リストに正確一致した dev channel を持つ起動でのみ自動許可）。
    if (gate === "devChannels" && !this.devChannelsGateAnswered) {
      this.devChannelsGateAnswered = true;
      this.proc.write("1\r");
      this.gateScanBuffer = ""; // 次のダイアログ検知のため一旦クリア
      const msg = `起動ゲート自動応答: development channels 警告に "1"+Enter を送信（許可リスト限定・ready 前）`;
      console.log(`[ebi-team] [${this.id}] ${msg}`);
      this.handlers.onNotice(this.id, msg);
      return;
    }

    // workspace trust 確認。
    if (gate === "trust" && !this.trustGateAnswered) {
      this.trustGateAnswered = true;
      this.proc.write("1\r");
      this.gateScanBuffer = "";
      const msg = `起動ゲート自動応答: workspace trust 確認に "1"+Enter を送信（ready 前）`;
      console.log(`[ebi-team] [${this.id}] ${msg}`);
      this.handlers.onNotice(this.id, msg);
    }
  }

  /**
   * 送信元タグ付き注入。idle なら即送信、busy ならキューへ。
   * フォーマット: 本文 `[from:<from>] <message>` を書き、少し待ってから Enter を別 write で送る
   * （TUI のペースト検知で送信されない問題を回避＝送信まで担保）。キューは本文(改行なし)を保持。
   */
  inject(from: string, message: string): void {
    const body = `[from:${from}] ${message}`;
    if (this.getStatus() === "idle") {
      void this.sendLine(body);
    } else {
      this.injectQueue.push(body);
      this.handlers.onNotice(
        this.id,
        `busy のため注入をキューに保留（待ち ${this.injectQueue.length} 件）`,
      );
    }
  }

  /** 本文を stdin へ書き、ENTER_DELAY_MS 待ってから Enter(`\r`) を別 write で送って送信を確定させる。 */
  private async sendLine(body: string): Promise<void> {
    if (this.disposed) return;
    this.proc.write(body);
    await sleep(ENTER_DELAY_MS);
    if (this.disposed) return;
    this.proc.write("\r");
  }

  /** registry へ書き出すスナップショット。 */
  toRecord(): AgentRecord {
    return {
      id: this.id,
      cwd: this.cwd,
      branch: this.branch,
      status: this.getStatus(),
      mode: this.mode,
      pid: this.pid,
      kind: this.kind,
      pinned: this.pinned,
      model: this.model,
      role: this.role,
    };
  }

  kill(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detector.dispose();
    // ready 待ちを false で解決し、boot タイマも止める。
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }
    this.resolveReadyWaiters(false);
    // MVP は生存 agent のみスクロールバックを保持する方針。exit/kill で破棄する。
    this.scrollbackChunks.length = 0;
    this.scrollbackSize = 0;
    try {
      this.proc.kill();
    } catch {
      // 既に死んでいる場合は無視。
    }
  }

  private onBusy(): void {
    this.handlers.onStatus(this.id, "busy");
  }

  private onIdle(): void {
    this.handlers.onStatus(this.id, "idle");
    // ready 判定: boot 猶予を過ぎていて idle に達したら ready とみなす。
    this.promoteReadyIfEligible();
    void this.flushQueue();
    // [B] idle 自動通知（保険）。idleDetector は busy→idle のエッジでのみ onIdle を
    // 呼ぶため、ここで判定すれば「同一 idle 区間で 1 回だけ」が自然に担保される。
    this.maybeIdleNotify();
  }

  /**
   * [B] idle 自動通知の発火判定。以下を全て満たすときだけ onIdleNotify を呼ぶ:
   *  - 機能が on（EBI_IDLE_NOTIFY）
   *  - master/supervisor 以外（自分宛ループ・要約役の誤通知を防ぐ）
   *  - 一度でも ready 済み（起動直後の初期化 idle で誤通知しない）
   *  - 直近 REPLY_SUPPRESS_MS 内に A（reply_to_master）が無い（A を呼んだら B は黙る）
   *  - 直近 IDLE_NOTIFY_COOLDOWN_MS 内に B を出していない（通知洪水のレート制限）
   */
  private maybeIdleNotify(): void {
    if (!IDLE_NOTIFY_ENABLED) return;
    if (this.kind === "master" || this.kind === "supervisor") return;
    if (!this.hasBeenReady) return;
    const now = Date.now();
    if (now - this.lastReplyAt < REPLY_SUPPRESS_MS) return;
    if (now - this.lastIdleNotifyAt < IDLE_NOTIFY_COOLDOWN_MS) return;
    this.lastIdleNotifyAt = now;
    this.handlers.onIdleNotify?.(this.id);
  }

  /** idle 復帰時にキューに溜まった注入を順番に流す（各件 本文→Enter を分離送信）。 */
  private async flushQueue(): Promise<void> {
    if (this.injectQueue.length === 0) return;
    const count = this.injectQueue.length;
    while (this.injectQueue.length > 0) {
      const body = this.injectQueue.shift()!;
      await this.sendLine(body);
      // 次の件と混ざらないよう、送信確定後に間隔を空ける。
      if (this.injectQueue.length > 0) await sleep(ENTER_DELAY_MS);
    }
    this.handlers.onNotice(this.id, `idle 復帰: 保留していた注入 ${count} 件を flush`);
  }
}
