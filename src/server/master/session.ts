// MasterSession — MasterBrain を 1 本抱え、チャット UI・mailbox・usage を繋ぐセッション管理。
//
// 設計書: docs/design/master-chat-ui-2026-09-05.md §2.2 / §5.4 / §8-R1 / §8-R3（r3）
//
// 役割:
//  - ui:"chat" の master のライフサイクル（起動 / プロセス死亡 → `--resume` 自動復帰 / 停止）
//  - MasterEvent → ワイヤ表現（MasterChatEvent）への写像と seq 採番・JSONL 永続化・snapshot
//  - ボス発話（chatSend）とエビ返信（reply_to_master / reverse-inject）を **同じ 1 本の口**
//    （brain.send）へ載せる。PTY 注入・エコー照合は chat モードでは一切使わない
//  - usage / cost / rate limit をサーバ側の UsageStore（→ contextGuard）へ供給する
//
// このファイルは PTY（node-pty）にも registry にも依存しない。サーバ配線は index.ts が持ち、
// registry へは「chat 配送先」として自分を登録してもらう（registry.setChatTarget）。

import { MAX_REPLY_EXCERPT } from "../../shared/protocol.ts";
import type {
  AgentRecord,
  ChatAttachment,
  ChatImage,
  ChatReplyRef,
  MasterChatEnvelope,
  MasterChatEvent,
  MasterChatState,
  MasterChatUsage,
  UsageRateLimits,
} from "../../shared/protocol.ts";
import type { PermissionMode } from "../backends/types.ts";
import {
  MasterCostLedger,
  type MasterBrain,
  type MasterBrainId,
  type MasterEvent,
} from "./brain.ts";
import type {
  MasterPermissionDecision,
  MasterPermissionRequest,
} from "./permission.ts";
import { ChatLog } from "./chatLog.ts";
import { createMasterBrain } from "./index.ts";
import { parseRateLimitEvent } from "./rateLimit.ts";

/**
 * プロセス死亡からの `--resume` 自動復帰ポリシー（設計書 §8-R1）。
 * 値は固定エビの DEFAULT_RESTART_POLICY（src/server/fixedEbi.ts）と揃えてある
 * （PTY 時代の自動再起動と同じ体感にするため）。fixedEbi.ts は node-pty に依存するので
 * ここでは import せず、同じ値を持つ。
 */
export interface MasterRestartPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  maxConsecutiveFailures: number;
  /** これ以上生存したら「正常に動いた」とみなし連続失敗カウンタをリセットする閾値(ms)。 */
  minHealthyMs: number;
}

export const DEFAULT_MASTER_RESTART_POLICY: MasterRestartPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxConsecutiveFailures: 5,
  minHealthyMs: 10_000,
};

/**
 * 投入 ACK（`--replay-user-messages`）を待つ上限(ms)。
 * PoC 実測は 3.4s / 4.7s。reply_to_master の HTTP 応答をこの時間ブロックするため、
 * ClaudeHeadlessBrain の既定（60s）より短くする。**タイムアウトしても再送はしない**
 * （二重投入になる。acked:false を正直に返すだけ）。
 */
export const MASTER_ACK_TIMEOUT_MS = 20_000;

/** メモリに保持する会話イベントの上限（snapshot 用のリングバッファ）。 */
export const DEFAULT_SNAPSHOT_LIMIT = 400;

/** UsageStore へ渡す chat master の使用状況（statusLine JSON の代替）。 */
export interface MasterUsageSnapshot {
  model: string | null;
  /** プロセスを跨いだ会話としての累計コスト(USD)。 */
  costUsd: number | null;
  contextUsedPct: number | null;
  contextSize: number | null;
  tokens: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheCreation: number | null;
  };
}

export interface MasterSessionHandlers {
  /** 会話イベント 1 件（WS `chatEvent` の broadcast）。 */
  onEvent(id: string, envelope: MasterChatEnvelope): void;
  /** 状態変化（WS `chatState` の broadcast）。 */
  onState(id: string, state: MasterChatState, pending: number): void;
  /** UI notice（既存 notice 経路。起動失敗・自動復帰など運用者に見せるもの）。 */
  onNotice(id: string, text: string): void;
  /** usage の供給（UsageStore → contextGuard）。 */
  onUsage(id: string, usage: MasterUsageSnapshot): void;
  /** レート制限枠の供給（アカウント単位・latest）。 */
  onRateLimits(id: string, limits: Partial<UsageRateLimits>): void;
  /** registry 表示の更新要求（status/pid が変わったとき）。 */
  onRegistryChange(): void;
}

export interface MasterSessionOptions {
  /** master の agent id（既定 "master"）。 */
  id: string;
  brainId: MasterBrainId;
  cwd: string;
  model: string | null;
  permissionMode: PermissionMode | null;
  systemPrompt: string | null;
  /** claude 方言の `--mcp-config` に渡す JSON パス（既存 .ebi-team/master-control*.mcp.json）。 */
  mcpConfigPath: string | null;
  /** config の args（そのまま末尾へ付く）。 */
  extraArgs: readonly string[];
  /** 会話 JSONL の保存先（null ならメモリのみ）。 */
  logPath: string | null;
  handlers: MasterSessionHandlers;
  /** メモリ保持するイベント数（snapshot 用）。 */
  snapshotLimit?: number;
  restartPolicy?: MasterRestartPolicy;
  /** テスト用の差し替え口（既定は createMasterBrain）。 */
  createBrain?: (
    id: MasterBrainId,
    opts: {
      costLedger: MasterCostLedger;
      onRawEvent: (raw: unknown) => void;
      ackTimeoutMs: number;
      includePartialMessages: boolean;
    },
  ) => MasterBrain;
}

/**
 * MasterEvent（サーバ内部）→ MasterChatEvent（ワイヤ）の写像。
 *
 * - `ack` は send() の返り値で扱うので UI へは流さない（null）。
 * - 新しい MasterEvent の kind を足すと、この switch の `never` チェックで**コンパイルエラー**に
 *   なる（ワイヤ表現の更新漏れを型で止める）。
 */
export function toChatEvent(ev: MasterEvent, totalCostUsd: number | null): MasterChatEvent | null {
  switch (ev.kind) {
    case "ack":
      return null;
    case "session":
      return {
        kind: "session",
        sessionId: ev.sessionId,
        model: ev.model,
        apiKeySource: ev.apiKeySource,
        mcpServers: ev.mcpServers,
        capabilities: ev.capabilities,
      };
    case "text":
      return { kind: "text", text: ev.text, partial: ev.partial };
    case "thinking":
      return { kind: "thinking", text: ev.text, partial: ev.partial };
    case "toolCall":
      return { kind: "toolCall", id: ev.id, name: ev.name, input: ev.input };
    case "toolResult":
      return { kind: "toolResult", id: ev.id, ok: ev.ok, content: ev.content };
    case "permission":
      return {
        kind: "permission",
        id: ev.id,
        toolName: ev.toolName,
        input: ev.input,
        ...(ev.suggestions ? { suggestions: ev.suggestions } : {}),
      };
    case "question":
      return {
        kind: "question",
        id: ev.id,
        header: ev.header,
        question: ev.question,
        options: ev.options,
        multi: ev.multi,
      };
    case "turnEnd":
      return {
        kind: "turnEnd",
        ok: ev.ok,
        aborted: ev.aborted,
        usage: ev.usage as MasterChatUsage | null,
        costUsd: ev.costUsd,
        totalCostUsd,
        errorText: ev.errorText,
      };
    case "permissionSettled":
      return { kind: "permissionSettled", id: ev.id, outcome: ev.outcome, answer: ev.answer };
    case "notice":
      return { kind: "notice", level: ev.level, text: ev.text };
    case "exit":
      return { kind: "exit", code: ev.code, signal: ev.signal };
    default: {
      const never: never = ev;
      void never;
      return null;
    }
  }
}

/**
 * 会話ログの中で**まだ決着していない**承認/質問の id を古い順に返す純関数。
 *
 * サーバ再起動でトランスクリプトを復元したときに使う。保留は頭脳プロセスと
 * 運命を共にするので、復元された保留は例外なく「破棄」になる。
 */
export function unsettledRequestIds(envelopes: readonly MasterChatEnvelope[]): string[] {
  // **id は会話を跨いで再利用されうる**（頭脳プロセスが入れ替わると tool_use_id の採番が
  // 振り出しに戻る）。したがって「一度でも settled が出たか」ではなく
  // **その id の最後のイベントがどちらか**で判定する。
  const open = new Map<string, boolean>();
  for (const env of envelopes) {
    const ev = env.event;
    if (ev.kind === "permission" || ev.kind === "question") open.set(ev.id, true);
    else if (ev.kind === "permissionSettled") open.set(ev.id, false);
  }
  return [...open.entries()].filter(([, isOpen]) => isOpen).map(([id]) => id);
}

/** chat 配送（reply_to_master / reverse-inject）1 件分の入力。 */
export interface MasterChatDelivery {
  from: string;
  /** タグ無しの本文（UI の構造化フィールドへ入る）。 */
  message: string;
  /** `[reply] ` 等のタグ付き本文（そのまま brain の stdin へ載せる）。 */
  body: string;
  kind: "reply" | "idle" | "message";
}

export class MasterSession {
  readonly id: string;
  private readonly opts: MasterSessionOptions;
  private readonly handlers: MasterSessionHandlers;
  private readonly log = new ChatLog();
  private readonly ring: MasterChatEnvelope[] = [];
  private readonly costLedger = new MasterCostLedger();
  private readonly snapshotLimit: number;
  private readonly policy: MasterRestartPolicy;

  private brain: MasterBrain | null = null;
  /** イベント汲み出しループ（stop() で完了を待てるように保持する）。 */
  private pump: Promise<void> = Promise.resolve();
  private seq = 0;
  /** ring から落ちた古いイベントがあるか（chatSnapshot.hasMore 用）。 */
  private truncated = false;
  private stateValue: MasterChatState = "stopped";
  /**
   * 未応答の承認/質問の **id 集合**（件数ではなく集合で持つ）。
   *
   * 以前は permission/question で +1、permissionSettled で −1 する数え方だったが、
   * 同じ id の要求が二重に届くと +2 −1 = 1 が残り、UI に「未応答 1 件」の幽霊が
   * 永久に居座った（2026-09-08 の実事象）。集合なら何度来ても冪等になる。
   */
  private readonly pendingIds = new Set<string>();
  private lastSessionId: string | null = null;
  private lastModel: string | null = null;
  private startedAt = 0;
  private consecutiveFailures = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private pid: number | null = null;

  constructor(opts: MasterSessionOptions) {
    this.opts = opts;
    this.id = opts.id;
    this.handlers = opts.handlers;
    this.snapshotLimit = opts.snapshotLimit ?? DEFAULT_SNAPSHOT_LIMIT;
    this.policy = opts.restartPolicy ?? DEFAULT_MASTER_RESTART_POLICY;
    this.log.configure(opts.logPath);
  }

  get state(): MasterChatState {
    return this.stateValue;
  }

  get pendingCount(): number {
    return this.pendingIds.size;
  }

  /** 会話としての累計コスト(USD)。プロセスを跨いで足す（`--resume` で 0 に戻るため）。 */
  get totalCostUsd(): number {
    return this.costLedger.total();
  }

  /** registry サイドバー用の合成レコード（PTY を持たないので pid は子プロセスのもの）。 */
  record(): AgentRecord {
    return {
      id: this.id,
      cwd: this.opts.cwd,
      branch: null,
      // チャット UI の状態を registry の idle/busy へ写す（contextGuard の quiescence 判定が
      // 「master が idle か」を registry.list() から読むため、ここを埋めないとガードが死ぬ）。
      status: this.stateValue === "busy" ? "busy" : "idle",
      mode: "connected",
      pid: this.pid,
      kind: "master",
      pinned: true,
      model: this.opts.model,
      role: null,
      backend: this.opts.brainId,
    };
  }

  /**
   * 起動。プロセス死亡後の自動復帰でも同じ経路を通る（resume あり）。
   * 起動失敗は例外にせず notice + stopped 状態にする（サーバごと落とさない）。
   */
  async start(): Promise<void> {
    // 過去ログを復元しておく（サーバ再起動後も直近の会話が snapshot で戻る）。
    if (this.ring.length === 0) {
      const past = await this.log.tail(this.snapshotLimit);
      if (past.length > 0) {
        this.ring.push(...past);
        // 上限ちょうど読めた＝それより前がまだファイルに残っている可能性がある。
        this.truncated = past.length >= this.snapshotLimit;
        this.seq = Math.max(...past.map((e) => e.seq));
        // 前回のプロセスが抱えていた承認/質問は**もう答えられない**（MCP ツール呼び出しごと
        // 消えている）。UI が永久にボタンを出したままにならないよう破棄として畳む。
        for (const id of unsettledRequestIds(this.ring)) {
          this.emit({ kind: "permissionSettled", id, outcome: "discarded", answer: null });
        }
      }
    }
    await this.launch(null);
  }

  private async launch(resumeSessionId: string | null): Promise<void> {
    this.setState("starting");
    const create = this.opts.createBrain ?? ((id, o) => createMasterBrain(id, o));
    let brain: MasterBrain;
    try {
      brain = create(this.opts.brainId, {
        costLedger: this.costLedger,
        onRawEvent: (raw) => this.onRawEvent(raw),
        ackTimeoutMs: MASTER_ACK_TIMEOUT_MS,
        // PR-M3: チャット UI の逐次描画（partial）を有効化する。
        // 差分は `text`/`thinking` の partial:true として流れ、ブロック完了時に
        // partial:false の全文が来て置き換わる（claudeEvents.ts の正規化）。
        includePartialMessages: true,
      });
    } catch (err) {
      this.fail(`master 頭脳（${this.opts.brainId}）を作れませんでした: ${(err as Error).message}`);
      return;
    }
    this.brain = brain;
    this.startedAt = Date.now();
    try {
      await brain.start({
        cwd: this.opts.cwd,
        model: this.opts.model,
        permissionMode: this.opts.permissionMode,
        systemPrompt: this.opts.systemPrompt,
        controlMcp: null,
        mcpConfigPath: this.opts.mcpConfigPath,
        resumeSessionId,
        extraArgs: this.opts.extraArgs,
      });
    } catch (err) {
      this.brain = null;
      this.fail(`master（chat）の起動に失敗しました: ${(err as Error).message}`);
      this.scheduleRestart();
      return;
    }
    this.pid = brain.pid ?? null;
    this.pump = this.runPump(brain);
    this.setState("idle");
    if (resumeSessionId) {
      this.handlers.onNotice(
        this.id,
        `master（chat）を --resume ${resumeSessionId} で復帰させました`,
      );
    }
  }

  /** イベントの汲み出しループ。brain が終わる（プロセス exit）まで回る。 */
  private async runPump(brain: MasterBrain): Promise<void> {
    try {
      for await (const ev of brain.events()) {
        this.onBrainEvent(ev);
      }
    } catch (err) {
      this.emit({ kind: "notice", level: "error", text: `イベント読み取りで例外: ${(err as Error).message}` });
    }
  }

  private onBrainEvent(ev: MasterEvent): void {
    switch (ev.kind) {
      case "session": {
        this.lastSessionId = ev.sessionId;
        this.lastModel = ev.model;
        const control = ev.mcpServers.find((s) => s.name === "ebi-control");
        if (!control || control.status !== "connected") {
          // R5: 「ツールが見えないまま会話が始まる」静かな故障を、文面ではなく構造で検出する。
          this.handlers.onNotice(
            this.id,
            `master（chat）の ebi-control MCP が connected ではありません（${control?.status ?? "未接続"}）。` +
              `spawn / send_message / reply_to_master が使えない状態です`,
          );
        }
        break;
      }
      case "turnEnd": {
        this.costLedger.noteProcessTotal(this.processKey(), ev.costUsd);
        // PR-M6: usage を出す**前に**状態を落とす。contextGuard の「キリが良いか」判定は
        // registry の master status（= this.stateValue）を読むので、busy のまま usage を
        // 渡すと /clear 促し（quiescent 通知）が永久に発火しない。
        this.setState(this.pendingIds.size > 0 ? "waiting" : "idle");
        if (ev.usage) {
          this.handlers.onUsage(this.id, {
            model: this.lastModel ?? this.opts.model,
            costUsd: this.costLedger.total(),
            contextUsedPct: ev.usage.contextUsedPct,
            contextSize: ev.usage.contextSize,
            tokens: {
              input: ev.usage.input,
              output: ev.usage.output,
              cacheRead: ev.usage.cacheRead,
              cacheCreation: ev.usage.cacheCreation,
            },
          });
        }
        break;
      }
      case "permission":
      case "question": {
        this.pendingIds.add(ev.id);
        this.setState("waiting");
        break;
      }
      case "permissionSettled": {
        this.pendingIds.delete(ev.id);
        // 保留が解けたらターンの実行へ戻る。**waiting のときだけ**動かす
        //（exit → discardAll の順で来たときに stopped を busy へ上書きしないため）。
        if (this.stateValue === "waiting") this.setState(this.pendingIds.size > 0 ? "waiting" : "busy");
        break;
      }
      case "notice": {
        if (ev.level !== "info") this.handlers.onNotice(this.id, `master（chat）: ${ev.text}`);
        break;
      }
      case "exit": {
        this.onExit(ev.code, ev.signal);
        break;
      }
      default:
        break;
    }
    this.emit(ev);
  }

  /** 生イベントの覗き口（rate_limit_event → UsageStore の枠情報）。 */
  private onRawEvent(raw: unknown): void {
    const limits = parseRateLimitEvent(raw);
    if (limits) this.handlers.onRateLimits(this.id, limits);
  }

  private processKey(): string {
    return this.lastSessionId ?? `pid-${this.pid ?? 0}-${this.startedAt}`;
  }

  private onExit(code: number | null, signal: string | null): void {
    this.brain = null;
    this.pid = null;
    this.pendingIds.clear();
    if (this.stopping) {
      this.setState("stopped");
      return;
    }
    const aliveMs = Date.now() - this.startedAt;
    if (aliveMs >= this.policy.minHealthyMs) this.consecutiveFailures = 0;
    else this.consecutiveFailures += 1;
    this.handlers.onNotice(
      this.id,
      `master（chat）のプロセスが終了しました（code=${code} signal=${signal} 生存 ${aliveMs}ms）`,
    );
    this.setState("stopped");
    this.scheduleRestart();
  }

  /** プロセス死亡 → `--resume <sessionId>` で自動復帰（設計書 §8-R1）。 */
  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    if (this.consecutiveFailures >= this.policy.maxConsecutiveFailures) {
      this.handlers.onNotice(
        this.id,
        `master（chat）が短時間に ${this.consecutiveFailures} 回連続で終了したため自動復帰を停止しました` +
          `（crashloop 防止）。設定を確認してください`,
      );
      return;
    }
    const exp = Math.max(0, this.consecutiveFailures - 1);
    const delay = Math.min(this.policy.baseDelayMs * 2 ** exp, this.policy.maxDelayMs);
    this.handlers.onNotice(this.id, `master（chat）を ${delay}ms 後に自動復帰させます`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      void this.launch(this.lastSessionId).catch((err) => {
        this.fail(`master（chat）の自動復帰に失敗: ${(err as Error).message}`);
      });
    }, delay);
    // サーバの終了を遅らせない（復帰待ちだけでプロセスを生かさない）。
    this.restartTimer.unref?.();
  }

  private fail(text: string): void {
    this.handlers.onNotice(this.id, text);
    this.emit({ kind: "notice", level: "error", text });
    this.setState("stopped");
  }

  /**
   * ボスの発話（WS `chatSend`）。
   * ACK（`--replay-user-messages`）は 3〜5 秒かかるので**待たずに返す**（呼び出し側は投げっぱなし）。
   */
  async sendUserText(
    text: string,
    opts: {
      /** stream-json の image content block として載せる実体（サーバが読み出したもの）。 */
      images?: { mediaType: string; base64: string }[];
      /** UI 表示・master への提示用のメタ（保存先の絶対パスを含む）。 */
      attachments?: ChatAttachment[];
      /** 返信の引用元（PR-M11）。既に sanitize 済みのものを渡す。 */
      replyTo?: ChatReplyRef;
    } = {},
  ): Promise<{ accepted: boolean; reason?: string }> {
    const brain = this.brain;
    if (!brain) return { accepted: false, reason: "master（chat）が起動していません" };
    const attachments = opts.attachments ?? [];
    const replyTo = opts.replyTo;
    this.emitChat({
      kind: "user",
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(replyTo ? { replyTo } : {}),
    });
    this.markBusy();
    // 画像は image ブロックとして載せるが、**絶対パスも本文に添える**。
    // master がツール（Read/Bash）で同じファイルを扱えるようにするためで、
    // 画像そのものの内容は image ブロック側から伝わる。
    // 引用ヘッダ → 本文 → 添付フッタ の順で組む。
    // 引用は master の CLI からも 1 行で読める形にする（どの発言への返答かが本文だけで分かる）。
    const body = [
      ...(replyTo ? [replyQuoteLine(replyTo)] : []),
      text,
      ...(attachments.length > 0 ? [`\n[添付ファイル]\n${attachments.map((a) => a.path).join("\n")}`] : []),
    ].join("\n");
    const images = opts.images ?? [];
    void brain.send({ text: body, ...(images.length > 0 ? { images } : {}) }).catch((err) => {
      this.emit({ kind: "notice", level: "error", text: `送信に失敗しました: ${(err as Error).message}` });
    });
    return { accepted: true };
  }

  /**
   * エビからの配送（reply_to_master / idle 通知 / inject_message）。
   * PTY 注入は使わず **stdin の user メッセージ 1 行**として届ける。
   * 返り値の confirmed は replay ACK（プロトコル上の投入 ACK）が取れたか。
   */
  async deliverFromEbi(d: MasterChatDelivery): Promise<{ ok: boolean; confirmed: boolean }> {
    const brain = this.brain;
    if (!brain) return { ok: false, confirmed: false };
    this.emitChat({ kind: "inbound", from: d.from, tag: d.kind, text: d.message });
    this.markBusy();
    try {
      const { acked } = await brain.send({ text: d.body });
      return { ok: true, confirmed: acked };
    } catch (err) {
      this.emit({ kind: "notice", level: "error", text: `エビ返信の投入に失敗: ${(err as Error).message}` });
      return { ok: false, confirmed: false };
    }
  }

  /**
   * master がチャットへ共有した画像を 1 件トランスクリプトへ載せる（PR-M10）。
   *
   * `user` / `inbound` と同じ「ワイヤ側にしか無い kind」なので emitChat を直接呼ぶ
   * （MasterEvent には足さない＝ backend 実装に影響しない）。seq 採番・JSONL 追記・
   * WS broadcast は既存経路に乗るので、**再起動後の snapshot 復元も追加実装ゼロ**で効く。
   * JSONL に載るのは basename と表示メタだけ（base64 は載らない＝ログが肥大しない）。
   */
  shareImage(images: readonly ChatImage[]): void {
    if (images.length === 0) return;
    this.emitChat({ kind: "image", images: [...images] });
  }

  /** 実行中ターンの中断（WS `chatStop`）。会話は殺さない。 */
  async interrupt(): Promise<void> {
    await this.brain?.interrupt();
  }

  /**
   * 承認/質問への応答（WS `chatAnswer`）。
   * pending の増減と状態遷移は **`permissionSettled` イベント側**で行う
   *（破棄・中断でも同じ経路を通るので、ここで先に引くと二重に減る）。
   */
  async answer(
    requestId: string,
    decision: { allow?: boolean; choice?: string[]; text?: string },
  ): Promise<void> {
    const brain = this.brain;
    if (!brain) throw new Error("master（chat）が起動していません");
    await brain.answer(requestId, {
      ...(decision.allow === undefined ? {} : { allow: decision.allow }),
      ...(decision.choice === undefined ? {} : { choice: decision.choice }),
      ...(decision.text === undefined ? {} : { note: decision.text }),
    });
  }

  /**
   * 未応答の承認/質問を**ブローカの台帳に合わせて畳む**（`POST /control/chat-pending-resync`）。
   *
   * UI 側にだけ残ってブローカには居ない「孤児」は、ボスが答えても
   * `未応答の承認/質問が見つかりません` になり自力では消えない。サーバ再起動や
   * 「新しい会話」を使わずに戻すための逃げ道。畳んだ件数を返す。
   */
  resyncPending(): number {
    // pendingPermissionIds を持たない backend（＝承認 UI 非対応）は台帳が空＝全部孤児。
    const live = new Set(this.brain?.pendingPermissionIds ?? []);
    const orphans = [...this.pendingIds].filter((id) => !live.has(id));
    for (const id of orphans) {
      // emit() は onBrainEvent を通らないので、集合からも自分で落とす。
      this.pendingIds.delete(id);
      this.emit({ kind: "permissionSettled", id, outcome: "discarded", answer: null });
    }
    // ブローカ側にだけ居る保留（イベント取りこぼし）も件数に反映しておく。
    for (const id of live) this.pendingIds.add(id);
    if (orphans.length > 0) {
      this.handlers.onNotice(
        this.id,
        `孤立していた未応答の承認/質問 ${orphans.length} 件を破棄しました（再同期）`,
      );
    }
    // waiting のときだけ動かす（stopped を busy へ上書きしない・settled と同じ扱い）。
    if (this.stateValue === "waiting") this.setState(this.pendingIds.size > 0 ? "waiting" : "busy");
    return orphans.length;
  }

  /**
   * `--permission-prompt-tool`（制御MCP の permission_prompt → `POST /control/chat-permission`）
   * から届いた承認要求。**ボスが答えるまで resolve しない**（自動拒否しない・裁定どおり）。
   * signal は HTTP 接続の切断（claude 側がツール呼び出しを諦めた）で発火する。
   */
  async handlePermissionRequest(
    req: MasterPermissionRequest,
    signal?: AbortSignal,
  ): Promise<MasterPermissionDecision> {
    const brain = this.brain;
    if (!brain) return { behavior: "deny", message: "master（chat）が起動していません" };
    if (!brain.requestPermission) {
      return {
        behavior: "deny",
        message: `頭脳（${this.opts.brainId}）は承認 UI に対応していません`,
      };
    }
    return brain.requestPermission(req, signal);
  }

  /**
   * 新しい会話を始める（WS `chatNew`）。
   *
   * ヘッドレス CLI には `/clear` が無いので、**プロセスを止めて `--resume` 無しで起動し直す**。
   * 文脈（＝CLI 側の会話履歴）がリセットされ、区切りとして `cleared` イベントを 1 件流す。
   * UI はこれを見てトランスクリプトを畳む（＝表示も軽くなる）が、JSONL は追記のままで
   * 過去は失われない。設計書 §10 Q-3 の「手動ボタン先行」。
   *
   * 自動復帰（scheduleRestart）と競合しないよう、停止中は stopping を立てて exit を吸収する。
   */
  async newConversation(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const wasStopping = this.stopping;
    this.stopping = true;
    try {
      await this.brain?.stop();
      await this.pump;
    } finally {
      this.stopping = wasStopping;
    }
    this.brain = null;
    this.pid = null;
    this.pendingIds.clear();
    // resume 先を捨てる＝次の起動は新しいセッション。コスト累計も会話単位でリセットする。
    this.lastSessionId = null;
    this.consecutiveFailures = 0;
    this.costLedger.reset();
    // 区切りは構造化イベントで流す（UI はここでトランスクリプトを畳んで軽くする）。
    this.emitChat({ kind: "cleared" });
    if (this.stopping) return; // サーバ終了と競合したときは起動し直さない。
    await this.launch(null);
  }

  /** 停止（サーバ終了時）。以降の自動復帰は行わない。 */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    await this.brain?.stop();
    await this.pump;
    this.brain = null;
    this.setState("stopped");
  }

  /**
   * 会話の一括復元（WS `chatSnapshot`）。
   * before 指定時はその seq より前を返す。events は seq 昇順。
   */
  snapshot(opts: { before?: number; limit?: number } = {}): { events: MasterChatEnvelope[]; hasMore: boolean } {
    const limit = Math.max(1, Math.min(opts.limit ?? this.snapshotLimit, this.snapshotLimit));
    const pool = opts.before == null ? this.ring : this.ring.filter((e) => e.seq < opts.before!);
    const events = pool.slice(-limit);
    // まだメモリ上に古いものが残っている、または ring から溢れた分がある（＝ JSONL にはある）。
    const oldestIsRingOldest =
      events.length > 0 && this.ring.length > 0 && events[0]!.seq === this.ring[0]!.seq;
    const hasMore = pool.length > events.length || (this.truncated && oldestIsRingOldest);
    return { events, hasMore };
  }

  /** ターン開始。未応答の承認/質問があるときは waiting を優先する（UI のスティッキーバー用）。 */
  private markBusy(): void {
    if (this.pendingIds.size > 0) return;
    this.setState("busy");
  }

  private setState(state: MasterChatState): void {
    if (this.stateValue === state) return;
    const wasBusy = this.stateValue === "busy";
    this.stateValue = state;
    this.handlers.onState(this.id, state, this.pendingIds.size);
    // registry の status（idle/busy）にも写す（contextGuard の quiescence 判定に効く）。
    if (wasBusy !== (state === "busy")) this.handlers.onRegistryChange();
  }

  private emit(ev: MasterEvent): void {
    const chat = toChatEvent(ev, this.costLedger.total());
    if (chat) this.emitChat(chat);
  }

  private emitChat(event: MasterChatEvent): void {
    this.seq += 1;
    const envelope: MasterChatEnvelope = { seq: this.seq, ts: Date.now(), event };
    this.ring.push(envelope);
    if (this.ring.length > this.snapshotLimit) {
      this.ring.splice(0, this.ring.length - this.snapshotLimit);
      this.truncated = true;
    }
    this.log.append(envelope);
    this.handlers.onEvent(this.id, envelope);
  }

  /** テスト用: 会話ログの書き込み完了を待つ。 */
  flushLog(): Promise<void> {
    return this.log.flush();
  }
}

// ===== 返信（引用）ヘルパ（PR-M11）=====

/**
 * クライアント由来の引用参照を安全な形にする。
 *
 * - seq は有限の正整数だけ通す（存在しない seq でも表示は壊れないので、存在確認まではしない）
 * - excerpt は制御文字（改行・タブを含む）を空白へ潰し、`MAX_REPLY_EXCERPT` で切る
 *   ＝ CLI へ渡る行が 1 行に収まり、長さでログを汚されない
 */
export function sanitizeReplyRef(ref: unknown): ChatReplyRef | undefined {
  if (!ref || typeof ref !== "object") return undefined;
  const { seq, excerpt } = ref as { seq?: unknown; excerpt?: unknown };
  if (typeof seq !== "number" || !Number.isFinite(seq) || !Number.isInteger(seq) || seq <= 0) {
    return undefined;
  }
  const raw = typeof excerpt === "string" ? excerpt : "";
  const flat = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return { seq, excerpt: flat.slice(0, MAX_REPLY_EXCERPT) };
}

/** master の CLI へ届く引用ヘッダ 1 行。 */
export function replyQuoteLine(ref: ChatReplyRef): string {
  return `> [reply to master#${ref.seq}] ${ref.excerpt}`;
}
