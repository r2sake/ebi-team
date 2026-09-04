import * as pty from "node-pty";
import { IdleDetector } from "./idleDetector.ts";
import type { AgentRecord, AgentStatus, AgentMode, AgentKind } from "../shared/protocol.ts";
import { deliveryText } from "../shared/deliveryTag.ts";
import {
  CLAUDE_BACKEND,
  applyEnvDenyList,
  getBackend,
  resolveBackendOrDefault,
  resolveIdleThresholdMs,
  type BackendId,
  type StartupGateKind,
  type StartupGateSpec,
} from "./backends/index.ts";

// 起動ゲート判定・dev channel 許可リストは Claude バックエンド（backends/claude.ts）が SoT。
// 既存の import 元（index.ts / test/gate.test.ts）を壊さないよう再エクスポートする。
export {
  BASE_ALLOWED_DEV_CHANNELS,
  detectStartupGate,
  isDevChannelsAutoAnswerEligible,
} from "./backends/index.ts";

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
 * 起動ゲート（trust / dev-channels 警告）自動応答を受け付ける「起動フェーズ」の時間窓(ms)。
 * spawn からこの時間内に出たダイアログにだけ応答する。
 * 注意: これらダイアログはセッションを入力待ちで沈黙させ、その沈黙を idle 検出器が拾って
 * hasBeenReady を立ててしまうため、ready フラグでは窓を判定できない（沈黙＝ready 誤昇格）。
 * よって spawn 時刻からの経過時間で「起動フェーズ限定」を担保する。dialog は spawn 後
 * 数秒で出るので十分広めに取る。env `EBI_GATE_WINDOW_MS` で調整可。
 */
const GATE_WINDOW_MS = Number(process.env.EBI_GATE_WINDOW_MS) || 90000;

/**
 * 起動ゲート自動応答が有効な agent で、「dev-channels ゲートへの応答が済むまで ready 昇格を
 * 待つ」上限(ms)。この時間を過ぎてもゲートを検知しなければ、従来どおりの ready 判定へ degrade する
 * （将来 claude 側がダイアログを出さなくなっても永久に ready にならない事故を防ぐ保険）。
 * 実測ではダイアログは spawn 後 2〜4 秒で出る。env `EBI_GATE_SETTLE_MS` で調整可。
 */
const GATE_SETTLE_MS = Number(process.env.EBI_GATE_SETTLE_MS) || 20000;

/**
 * プロセスグループ kill（killProcessGroup=true の backend）で、SIGTERM から SIGKILL までの猶予(ms)。
 * gemini は PTY リーダの下に「再 exec した子 node」と「その配下の stdio MCP」を持つため、
 * PTY を閉じるだけでは孤児が残る（PoC で 7 セッション分 21 プロセスの残存を実測）。
 * まずグループへ SIGTERM を送って正規の終了処理をさせ、居残りをこの猶予後に SIGKILL で刈る。
 * env `EBI_GROUP_KILL_GRACE_MS` で調整可。
 */
const GROUP_KILL_GRACE_MS = Number(process.env.EBI_GROUP_KILL_GRACE_MS) || 2000;

/**
 * プロセスグループへシグナルを送る（pty の子は forkpty により setsid 済み＝pid がそのまま pgid）。
 * 既に死んでいる（ESRCH）等は無視する。送れたら true。
 * 純粋な副作用ヘルパとして切り出してあるのは、単体テストで「グループ kill が呼ばれたか」だけを
 * 差し替えて確認できるようにするため。
 */
export function killProcessGroupSignal(
  pid: number,
  signal: NodeJS.Signals,
  killer: (target: number, sig: NodeJS.Signals) => void = (t, sg) => process.kill(t, sg),
): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    killer(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * PTY 注入の結果。
 * - "sent": 今この場で stdin へ書いた（相手の入力欄に入った）
 * - "queued": 相手が busy のため injectQueue に滞留した（idle 復帰時に flush される。
 *   この時点では相手はまだ本文を見ていない ＝ 到達確認済みとは呼べない）
 * - "suppressed": echo guard により注入を取りやめた（同じ本文が channel 経由で既に
 *   セッションへ到達していた ＝ 注入すると二重配送になる。EchoGuard 参照）
 */
export type InjectState = "sent" | "queued" | "suppressed";

/**
 * 注入直前に「同じメッセージが channel 経由で既にセッションへ描画されていないか」を照合するための印。
 *
 * 【2026-08-09 二重配送の根治（判定タイミング）】
 * deliver() のセッション到達確認は ECHO_CONFIRM_MS（既定 8s）で打ち切って PTY 注入へ
 * フォールバックする。しかし宛先が **busy** のときは、ACK 済みの channel 本文を harness が
 * ターン境界まで抱えて描画しないため、8s では原理的に間に合わない
 * （実測: master 宛 reply が 8.05s ちょうどで echo-timeout → PTY へ載せ替え）。
 * その PTY 注入も相手が busy なので injectQueue に滞留し、idle 復帰時に流れる。
 * 結果、master には「channel 経由の 1 通目」と「数分後に PTY の 2 通目」が届いていた。
 * そこで guard を持たせ、**実際に stdin へ書く直前**（idle 時は即座、busy 滞留時は flush 時）
 * に再照合し、既に描画されていれば注入を取りやめる。
 *
 * 【2026-08-16 二重配送の根治（判定手段）】
 * 上の修正でもタグ無しの二重着弾が続いた。真因は判定**手段**（本文の先頭 N 文字を針にする）で、
 * 針が文字数ベース・TUI の切り詰めが表示カラムベースだったため和文では原理的に一致しなかった
 * （詳細は src/shared/deliveryTag.ts の冒頭）。針を「msgId 入りの行頭タグそのもの」へ変更し、
 * 本文の言語・長さ・表示幅に依存しない照合にした。
 */
export interface EchoGuard {
  /**
   * 照合する行頭タグ（`deliveryTag(from, msgId)` の戻り値）。msgId で一意なので、
   * これが mark 以降に描画されていれば「この配送が届いた」と断定できる。
   */
  tag: string;
  /** 照合開始位置（push 直前に取った scrollbackMark）。これ以降の出力だけを見る。 */
  mark: number;
  /** 抑止したときに呼ばれる通知（配送ログ用。best-effort）。 */
  onSuppress?: () => void;
}

/**
 * guard 付き注入を「書く直前」に待てる猶予（ms）。flush（idle 復帰）の瞬間はまだ channel 本文の
 * 描画が終わっていないことがあるため、この時間だけエコーを待ってから最終判断する。
 * 0 以下で待たない。env `EBI_ECHO_FLUSH_GRACE_MS` で調整可。
 */
const ECHO_FLUSH_GRACE_MS = Number(process.env.EBI_ECHO_FLUSH_GRACE_MS ?? 4000);

/** guard 照合のポーリング間隔（ms）。 */
const ECHO_FLUSH_POLL_MS = 250;

/**
 * ANSI/OSC エスケープと空白を全除去して素文へ畳む。
 * claude(Ink) TUI は単語間を空白でなくカーソル移動エスケープで描画することがあるため、
 * 「空白を全部落とした文字列同士」で照合する（detectStartupGate と同じ流儀）。
 */
export function compactPlain(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .replace(/\s+/g, "");
}

/**
 * 配送の「セッション到達を照合するための針」を作る純関数。
 *
 * 【2026-08-16 本文照合 → タグ照合】
 * 針は `deliveryTag(from, msgId)` が返す行頭タグ（`[from:master#90] `）を compact したもの。
 * 旧実装は「本文の先頭 N 文字」を針にしていたが、claude TUI の channel 1 行描画は
 * **表示カラム**（実測 80 桁端末で約 56 桁）で切り詰めるのに対し針は**文字数**（既定 24）
 * で作られていたため、1 文字 = 2 カラムの和文では針が原理的に描画長を超え、照合が
 * 100% 失敗していた（詳細と実測は src/shared/deliveryTag.ts の冒頭）。
 *
 * タグなら必ず行頭にあり切り詰めの影響を受けず、msgId で一意なので本文の言語・長さ・
 * 表示幅に一切依存しない。空文字（タグ無し＝照合すべきものが無い）なら空を返す。
 */
export function echoNeedle(tag: string): string {
  return compactPlain(tag);
}

/**
 * scrollback 断片に配送のエコー（＝ claude セッションがそのメッセージを実際に描画したこと）が
 * 含まれるかを判定する純関数。TUI の空白潰し・行折返しに耐えるよう compact 同士で照合する。
 * tag には `deliveryTag(from, msgId)` の戻り値を渡す。針が空なら常に false（誤検知させない）。
 */
export function containsEcho(scrollbackChunk: string, tag: string): boolean {
  const needle = echoNeedle(tag);
  if (needle.length === 0) return false;
  return compactPlain(scrollbackChunk).includes(needle);
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

/**
 * バックエンド既定 env（TUI をインライン描画させる env 等）を注入するか。
 * 何を敷くかは backend が決める（Claude なら CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN 等。
 * 背景の詳細は backends/claude.ts のコメントを参照）。
 *
 * env `EBI_INLINE_TUI` を "off"/"0"/"false" にすると注入しない（従来挙動へ戻す非常口）。
 * 親 env / launch.env で同名キーを明示指定した場合はそちらが優先される。
 */
const INLINE_TUI_ENABLED = !["off", "0", "false"].includes(
  (process.env.EBI_INLINE_TUI ?? "on").toLowerCase(),
);

/**
 * pty に渡す env を組み立てる純関数。優先度は低い順に
 * 「バックエンド既定 env < 親 env（envDenyList 適用後） < launch.env」。
 * 親 env に同名キーがあればユーザーの明示指定として尊重する。
 *
 * backendEnv 未指定時は Claude バックエンドの既定を使う。EBI_COMMAND=bash 等の
 * スタブ起動でも従来どおり同じ env が敷かれる（外形ゼロ差分のため意図的）。
 */
export function buildSpawnEnv(
  parentEnv: Record<string, string | undefined>,
  launchEnv?: Record<string, string>,
  inlineTui: boolean = INLINE_TUI_ENABLED,
  backendEnv: Record<string, string> = CLAUDE_BACKEND.buildEnv(),
  envDenyList: readonly string[] = CLAUDE_BACKEND.envDenyList,
): Record<string, string> {
  const merged: Record<string, string> = inlineTui ? { ...backendEnv } : {};
  // 親 env の継承分からだけ deny list のキーを落とす（claude は空＝従来と完全に同一）。
  // ebi-team 自身が渡す backendEnv / launchEnv は対象外（意図して渡している値のため）。
  const inherited = applyEnvDenyList(parentEnv, envDenyList);
  // 値が undefined のキーで既定を握り潰さない（spread だと undefined でも上書きされてしまう）。
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) merged[key] = value;
  }
  for (const [key, value] of Object.entries(launchEnv ?? {})) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

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
  /**
   * このエビを動かすバックエンド id（起動引数/env/起動ゲート/通信路の性質を決める）。
   * 未指定なら command から解決する（さらに一致しなければ既定 "claude"）。
   */
  backend?: BackendId;
  /**
   * 制御MCP（ebi-control）の設定ファイルパス（claude 方言の JSON）。null/未指定なら制御MCP なし。
   * claude では args（--mcp-config）に既に載っているが、gemini は env 経由で渡すため
   * backend.buildEnv() にも同じ情報を渡す必要がある（PR-C）。
   */
  mcpConfigPath?: string | null;
  /**
   * 役割注入プロンプト。claude では args（--append-system-prompt）に載っているが、
   * gemini は per-エビ GEMINI.md 経由で渡すため buildEnv にも渡す（PR-C）。
   */
  systemPrompt?: string | null;
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
  /** このエビを動かしているバックエンド id（PR1 時点では常に "claude"）。 */
  readonly backend: BackendId;
  /** kill 時にプロセスグループごと落とすか（backend のトレイト。gemini のみ true）。 */
  private readonly killProcessGroup: boolean;
  /**
   * 「入力受付（プロンプト表示）」を示す出力パターン（backend のトレイト。null なら従来判定）。
   * これを持つ backend は、パターンを一度も見ていない間は ready へ昇格しない。
   */
  private readonly readyPattern: RegExp | null;
  /** readyPattern を検出済みか。 */
  private readyPatternSeen = false;
  /** readyPattern 走査用の素文リングバッファ。 */
  private readyScanBuffer = "";
  /** 起動フェーズの致命エラー文言（backend のトレイト）。検出済みのものは二度出さない。 */
  private readonly fatalPatterns: readonly { readonly pattern: RegExp; readonly message: string }[];
  private readonly reportedFatals = new Set<string>();
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
  /** busy 中に保留された注入（本文＋任意の echo guard）。 */
  private readonly injectQueue: { body: string; guard?: EchoGuard }[] = [];
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
  /**
   * 起動ゲート待ちの上限（GATE_SETTLE_MS）満了時に ready 昇格を再評価するタイマ。
   * ダイアログを検知できないまま出力も止まった場合に、degrade 判定を確実に走らせる。
   */
  private gateSettleTimer: NodeJS.Timeout | null = null;

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
  /** バックエンドの起動ゲート定義（文言・応答・許可リスト）。ゲートを出さない backend は null。 */
  private readonly gateSpec: StartupGateSpec | null;
  /** 既に応答済みのゲート種別（多重送信防止）。 */
  private readonly answeredGates = new Set<StartupGateKind>();
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
  /**
   * これまでに追記した scrollback の総文字数（リングバッファで捨てた分も含む単調増加カウンタ）。
   * 「ある時点以降に出力された分だけ」を切り出す（scrollbackSince）ための位置マークに使う。
   */
  private scrollbackTotalChars = 0;

  // ===== channel（notification）配送のセッション到達確認 =====
  /**
   * このエビの channel 受信が「セッションに実際に届く」ことを一度でも確認できたか。
   * 未確認のうちは deliver() が配送のたびに本文エコーを scrollback で照合し、
   * 出なければ PTY 注入へフォールバックする（spawn 直後の取りこぼし根治）。
   * 確認できたら暫くは照合をスキップする（既存セッションへの再送は元々取りこぼさないため、
   * 無駄な待ちと重複配送を作らない）。ただし「永久に信用する」ことはしない（channelProvenAt 参照）。
   */
  private channelProven = false;

  /** 直近に channel 到達を確認できた時刻（epoch ms）。null は未確認。 */
  private channelProvenAt: number | null = null;

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
    // バックエンドは launch.backend（明示） > command からの解決 > 既定(claude) の順で決める。
    const backend = launch.backend
      ? getBackend(launch.backend)
      : resolveBackendOrDefault(launch.command);
    this.backend = backend.id;
    this.killProcessGroup = backend.killProcessGroup;
    this.readyPattern = backend.readyPattern ?? null;
    this.fatalPatterns = backend.fatalPatterns ?? [];
    this.gateSpec = backend.startupGates;
    this.autoAnswerStartupGates = this.gateSpec
      ? this.gateSpec.isAutoAnswerEligible(
          launch.args,
          config.devChannelsAllowlist ?? this.gateSpec.baseAllowlist,
        )
      : false;

    // idle しきい値は backend が上書きできる（null ならサーバ既定＝従来どおり）。
    this.detector = new IdleDetector(
      resolveIdleThresholdMs(backend.idleThresholdMs, config.idleThresholdMs),
      () => this.onIdle(),
      () => this.onBusy(),
    );

    // 引数配列方式で起動（シェル非経由）。長文の --append-system-prompt も安全に渡る。
    // launch.env があれば親 env にマージする（engineer の EBI_ID 等。子の stdio MCP が継承する）。
    // さらに TUI をインライン描画させる既定 env を最下位優先で敷く（xterm.js のスクロール確保）。
    // inlineTui の on/off は backend.buildEnv() へ渡して backend に判断させる
    // （claude は off なら空を返す＝従来と同一。gemini の system settings パスのように
    //   「TUI 描画ではなく起動の必須条件」である env まで落とさないため）。
    const spawnEnv = buildSpawnEnv(
      process.env,
      launch.env,
      true,
      backend.buildEnv({
        agentId: id,
        inlineTui: INLINE_TUI_ENABLED,
        mcpConfigPath: launch.mcpConfigPath ?? null,
        systemPrompt: launch.systemPrompt ?? null,
      }),
      backend.envDenyList,
    );
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
      this.maybeMarkReadyPattern(meaningful);
      this.maybeReportFatal(meaningful);
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
      if (this.gateSettleTimer) {
        clearTimeout(this.gateSettleTimer);
        this.gateSettleTimer = null;
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

    // 起動ゲート待ち（degrade）の再評価タイマ。ダイアログを検知できないまま出力も止まった
    // ケースで、GATE_SETTLE_MS 満了後に確実に ready 判定をやり直す。
    if (this.autoAnswerStartupGates) {
      this.gateSettleTimer = setTimeout(() => {
        this.gateSettleTimer = null;
        this.promoteReadyIfEligible();
      }, GATE_SETTLE_MS + 50);
    }
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
    const elapsed = Date.now() - this.spawnedAt;
    if (elapsed < MIN_BOOT_MS) return;
    // backend が「プロンプト表示」の目印を持つなら、それを見るまで ready にしない。
    // gemini は OAuth トークン再取得中（"Waiting for authentication..."）に沈黙するため、
    // 「boot 猶予＋初回 idle」だけだとそこで ready 誤昇格して 1 通目が食われる（e2e で実測）。
    if (this.readyPattern !== null && !this.readyPatternSeen) return;
    // 起動ゲート自動応答が有効な agent は、dev-channels ダイアログへ応答するまで ready にしない。
    // ダイアログはセッションを入力待ちで沈黙させ、その沈黙を idle 検出器が拾うため、従来の
    // 「boot 猶予＋idle」だけだとダイアログ表示中に ready へ誤昇格していた（＝入力欄がまだ
    // 無いのに本文を注入して吸われる／channel も未登録で捨てられる、の温床）。
    // 保険: GATE_SETTLE_MS を過ぎてもゲートを検知できなければ従来判定へ degrade する
    // （将来 claude がダイアログを出さなくなっても永久に ready にならない事故を防ぐ）。
    const readyBlockingGate = this.gateSpec?.readyBlockingGate ?? null;
    if (
      this.autoAnswerStartupGates &&
      readyBlockingGate !== null &&
      !this.answeredGates.has(readyBlockingGate) &&
      elapsed < GATE_SETTLE_MS
    ) {
      return;
    }
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

  /**
   * 現在の scrollback 位置マークを返す。scrollbackSince(mark) と対で使い、
   * 「この時点より後に出力された分」だけを検査するために使う（過去の同種メッセージを
   * 到達エコーと誤認しないため）。
   */
  scrollbackMark(): number {
    return this.scrollbackTotalChars;
  }

  /**
   * mark 以降に出力された scrollback を返す。リングバッファで既に捨てられた区間は返せないため、
   * 保持している範囲で最大限（＝実際より広い範囲）を返す（安全側: 検査対象が広がるだけ）。
   */
  scrollbackSince(mark: number): string {
    const wanted = this.scrollbackTotalChars - mark;
    if (wanted <= 0) return "";
    const parts: string[] = [];
    let acc = 0;
    for (let i = this.scrollbackChunks.length - 1; i >= 0 && acc < wanted; i--) {
      const chunk = this.scrollbackChunks[i]!;
      parts.push(chunk);
      acc += chunk.length;
    }
    return parts.reverse().join("");
  }

  /** channel 受信のセッション到達を一度でも確認できたか（deliver のエコー照合スキップ判定）。 */
  isChannelProven(): boolean {
    return this.channelProven;
  }

  /**
   * 直近に channel 到達を確認できた時刻（epoch ms）。未確認なら null。
   * 「一度成功したら永久に信用する」を避け、一定時間が経ったら再確認するために使う
   * （長寿命の master ほど、購読の乗っ取り・ブリッジ死亡で静かに壊れうる）。
   */
  channelProvenAgeMs(nowMs = Date.now()): number | null {
    return this.channelProvenAt === null ? null : nowMs - this.channelProvenAt;
  }

  /** channel 受信のセッション到達が確認できたことを記録する（直近確認時刻を更新する）。 */
  markChannelProven(): void {
    this.channelProven = true;
    this.channelProvenAt = Date.now();
  }

  /** PTY 出力チャンクをリングバッファに追記し、上限超過分を古い方から捨てる。 */
  private appendScrollback(data: string): void {
    if (this.scrollbackBytes <= 0 || data.length === 0) return;
    this.scrollbackTotalChars += data.length;
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
  /**
   * backend の readyPattern（プロンプト表示の目印）を出力から探す。
   * 見つかったら ready 昇格を再評価する（この時点で既に idle・boot 猶予経過なら即 ready）。
   */
  private maybeMarkReadyPattern(chunk: string): void {
    if (this.readyPattern === null || this.readyPatternSeen || this.disposed) return;
    const plain = chunk
      .replace(/\x1b\][^\x07]*\x07/g, "")
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      .replace(/\x1b[()][A-Z0-9]/g, "");
    this.readyScanBuffer = (this.readyScanBuffer + plain).slice(-8192);
    if (!this.readyPattern.test(this.readyScanBuffer)) return;
    this.readyPatternSeen = true;
    this.readyScanBuffer = "";
    this.promoteReadyIfEligible();
  }

  /**
   * backend が宣言した致命エラー文言を出力から探し、見つけたら notice とサーバログへ出す。
   * ready 待ちが黙ってタイムアウトするより、原因の分かる 1 行を残す方が運用が早い。
   */
  private maybeReportFatal(chunk: string): void {
    if (this.fatalPatterns.length === 0 || this.disposed) return;
    if (this.reportedFatals.size === this.fatalPatterns.length) return;
    const plain = chunk
      .replace(/\x1b\][^\x07]*\x07/g, "")
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      .replace(/\x1b[()][A-Z0-9]/g, "");
    for (const { pattern, message } of this.fatalPatterns) {
      const key = pattern.source;
      if (this.reportedFatals.has(key)) continue;
      if (!pattern.test(plain)) continue;
      this.reportedFatals.add(key);
      console.error(`[ebi-team] [${this.id}] 起動エラー: ${message}`);
      this.handlers.onNotice(this.id, `起動エラー: ${message}`);
    }
  }

  private maybeAnswerStartupGates(chunk: string): void {
    const spec = this.gateSpec;
    if (this.disposed || !this.autoAnswerStartupGates || spec === null) return;
    // 起動フェーズ限定（spawn からの時間窓）。ready フラグは沈黙で誤昇格するため使わない。
    if (Date.now() - this.spawnedAt > GATE_WINDOW_MS) return;
    // このバックエンドが出しうるゲートに全部応答済みなら走査を打ち切る。
    if (spec.kinds.every((k) => this.answeredGates.has(k))) return;

    // ANSI/OSC を除去して素文にし、直近ぶんだけ保持（ダイアログ全文は数百字に収まる）。
    const plain = chunk
      .replace(/\x1b\][^\x07]*\x07/g, "")
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      .replace(/\x1b[()][A-Z0-9]/g, "");
    this.gateScanBuffer = (this.gateScanBuffer + plain).slice(-4096);
    // 空白なし照合等の固有ロジックは backend の detect（純関数）に集約している
    // （claude TUI が空白なしで描画する罠への対応は backends/claude.ts 参照）。
    const gate = spec.detect(this.gateScanBuffer);
    if (gate === null || this.answeredGates.has(gate)) return;

    this.answeredGates.add(gate);
    this.proc.write(spec.answerFor(gate));
    this.gateScanBuffer = ""; // 次のダイアログ検知のため一旦クリア
    const msg = spec.noticeFor(gate);
    console.log(`[ebi-team] [${this.id}] ${msg}`);
    this.handlers.onNotice(this.id, msg);
  }

  /**
   * 送信元タグ付き注入。idle なら即送信、busy ならキューへ。
   * 戻り値で「今 stdin へ送った（sent）／busy で滞留した（queued）」を区別する。
   * 滞留は idle 復帰まで相手の目に触れないため、呼び出し側はこれを confirmed と区別する。
   * フォーマット: 本文 `[from:<from>#<msgId>] <message>` を書き、少し待ってから Enter を別 write で
   * 送る（TUI のペースト検知で送信されない問題を回避＝送信まで担保）。キューは本文(改行なし)を保持。
   *
   * msgId は mailbox 採番の一意 id。notification 経路（control-server.ts）が emit する本文と
   * **完全に同じ表記**になるよう deliveryTag() を共用する（ここがズレると二重配送の抑止が
   * 静かに壊れる。test/dupDelivery.test.ts で錠前を掛けてある）。PTY 専用経路は採番が無いので
   * msgId を省略し、従来どおり `[from:<from>] ` になる。
   */
  inject(from: string, message: string, guard?: EchoGuard, msgId?: number | null): InjectState {
    const body = deliveryText(from, message, msgId);
    if (this.getStatus() === "idle") {
      // guard 付き（notify フォールバック由来）は、書く直前に「もう届いていないか」を確認する。
      if (guard && this.isEchoed(guard)) {
        guard.onSuppress?.();
        return "suppressed";
      }
      void this.sendLine(body);
      return "sent";
    }
    this.injectQueue.push({ body, guard });
    this.handlers.onNotice(
      this.id,
      `busy のため注入をキューに保留（待ち ${this.injectQueue.length} 件）`,
    );
    return "queued";
  }

  /** 現在 busy で滞留している注入の件数（可視化・破棄ログ用）。 */
  pendingInjectCount(): number {
    return this.injectQueue.length;
  }

  /**
   * 滞留中の注入を全て取り出して空にする（agent 破棄時に「何が失われたか」を記録するため）。
   * 破棄側でログ化しないと、キューの中身は警告すら出さず消える（旧挙動）。
   */
  drainInjectQueue(): string[] {
    return this.injectQueue.splice(0).map((e) => e.body);
  }

  /** guard のタグが mark 以降の scrollback に描画済みか（＝ channel 経由で既に到達したか）。 */
  private isEchoed(guard: EchoGuard): boolean {
    return containsEcho(this.scrollbackSince(guard.mark), guard.tag);
  }

  /**
   * guard 付き注入を書いてよいかの最終判断。既に描画済みなら false（抑止）。
   * まだなら graceMs だけ待って再照合する（flush の瞬間は描画が終わっていないことがあるため）。
   */
  private async shouldWriteGuarded(
    guard: EchoGuard,
    graceMs: number = ECHO_FLUSH_GRACE_MS,
  ): Promise<boolean> {
    if (this.isEchoed(guard)) return false;
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      await sleep(ECHO_FLUSH_POLL_MS);
      if (this.disposed) return false;
      if (this.isEchoed(guard)) return false;
    }
    return true;
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
      backend: this.backend,
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
    if (this.gateSettleTimer) {
      clearTimeout(this.gateSettleTimer);
      this.gateSettleTimer = null;
    }
    this.resolveReadyWaiters(false);
    // MVP は生存 agent のみスクロールバックを保持する方針。exit/kill で破棄する。
    this.scrollbackChunks.length = 0;
    this.scrollbackSize = 0;
    // backend が要求する場合はプロセスグループごと落とす（gemini: 子 node の再 exec と
    // その配下の stdio MCP が PTY リーダの kill だけでは孤児として残るため）。
    if (this.killProcessGroup && this.pid != null) {
      const pid: number = this.pid;
      killProcessGroupSignal(pid, "SIGTERM");
      const sweeper = setTimeout(() => {
        killProcessGroupSignal(pid, "SIGKILL");
      }, GROUP_KILL_GRACE_MS);
      // サーバ終了を妨げない（居残りが無ければ何もせず消える保険タイマ）。
      sweeper.unref?.();
    }
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
    let sent = 0;
    let suppressed = 0;
    while (this.injectQueue.length > 0) {
      const entry = this.injectQueue.shift()!;
      // guard 付き（notify フォールバック由来）は、書く直前に channel 経由の到達を再確認する。
      // busy 中に harness が抱えていた本文はこの前後で描画されるため、ここで初めて正しく判定できる。
      if (entry.guard && !(await this.shouldWriteGuarded(entry.guard))) {
        suppressed += 1;
        entry.guard.onSuppress?.();
        continue;
      }
      await this.sendLine(entry.body);
      sent += 1;
      // 次の件と混ざらないよう、送信確定後に間隔を空ける。
      if (this.injectQueue.length > 0) await sleep(ENTER_DELAY_MS);
    }
    const detail = suppressed > 0 ? `（送信 ${sent} 件・重複抑止 ${suppressed} 件）` : "";
    this.handlers.onNotice(this.id, `idle 復帰: 保留していた注入 ${count} 件を flush${detail}`);
  }
}
