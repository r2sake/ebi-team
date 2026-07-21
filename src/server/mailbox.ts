// notification 注入方式の郵便受け（mailbox）。
//
// 背景: 従来の send_message は PTY stdin へ本文を write する「入力欄タイプ方式」で、
// ペースト検知による Enter 消失・idle/busy ヒューリスティック誤判定・DSR 無応答での
// 永遠 busy 化などの脆さがあった。
//
// 新方式: 各エビの stdio 制御MCP ブリッジ（src/mcp/control-server.ts）が起動時に
// この mailbox へ long-poll で購読を張り、メッセージが届いたら
// `notifications/claude/channel` を emit してセッションへ注入する（PTY 入力欄は経由しない）。
//
// Mailbox はサーバ内メモリのみで完結する（プロセス跨ぎの永続化はしない = サーバ再起動で消える。
// 現行 PTY 方式も再起動で agent ごと消えるため対称）。
//
// 【2026-07-20 配送信頼性の根治】
// 従来は「一度でも subscribe したか（everSubscribed・単調フラグ）」だけを配送可否の判断に
// 使っていたため、購読が過去に成立した相手（master 含む）宛は、その後ブリッジの long-poll が
// 死んでいても・notification が harness に honor されなくても push しただけで delivered と
// みなされ、黙って消えていた（実害: master 宛メッセージ全損）。これを次の 3 点で作り直す:
//   1. liveness: 直近に long-poll が接続していた相手か（isLive）を配送ゲートに使う（単調フラグを廃止）。
//   2. end-to-end ACK: push したメッセージに seq id を振り、ブリッジが notification emit 後に
//      ack() を返す。deliver() 側は waitForAck() で到達確認できる（取れなければ PTY フォールバック）。
//   3. pending 可視化: 取りこぼし（未 ack・未回収）を snapshot で観測でき、黙って失われない。

/** mailbox に積む/配送する 1 件のメッセージ。 */
export interface MailboxMessage {
  /**
   * サーバ採番の一意 seq id（ack 相関・可視化に使う）。push 時に Mailbox が採番する。
   * 送信側（deliver）は push の戻り値としても受け取れる。
   */
  id: number;
  /** 送信元（"user" / "master" / エビ id）。 */
  from: string;
  /** 本文（reverseInject 由来なら [idle]/[reply] タグ込みの場合がある）。 */
  message: string;
  /** 種別（idle 自動通知 / エビからの明示リプライ / 通常送信）。 */
  kind: "message" | "reply" | "idle";
  /** 発生時刻（epoch ms）。 */
  ts: number;
}

interface Waiter {
  resolve: (msgs: MailboxMessage[]) => void;
  timer: NodeJS.Timeout;
}

interface AckWaiter {
  resolve: (acked: boolean) => void;
  timer: NodeJS.Timeout;
}

/** pending（未回収）メッセージの可視化スナップショット 1 件。 */
export interface PendingSnapshotEntry {
  id: string;
  count: number;
  /** この宛先が現在 live（直近に long-poll 接続あり）か。 */
  live: boolean;
  /** 最古の pending メッセージの経過 ms（なければ null）。 */
  oldestAgeMs: number | null;
}

/**
 * エビ id ごとの pending キュー + long-poll 購読を管理する。
 *
 * - push: 待機中の long-poll があれば即時 resolve、無ければ pending へ積む（順序保持）。採番した id を返す。
 * - subscribe: pending があれば即返す。無ければ最大 timeoutMs 待って push を待つ（無ければ空配列）。
 * - isLive: 直近 livenessWindowMs 以内に long-poll 接続があったか（= ブリッジが生きているか）。
 * - ack / waitForAck: ブリッジが emit したメッセージの到達確認（end-to-end ACK）。
 */
export class Mailbox {
  private readonly pending = new Map<string, MailboxMessage[]>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly subscribed = new Set<string>();
  /** id ごとの直近 long-poll 接続時刻（epoch ms）。liveness 判定に使う。 */
  private readonly lastPollAt = new Map<string, number>();
  /** メッセージ seq の採番元。 */
  private seq = 0;
  /** ack 待ちの解決関数（key: `${id} ${msgId}`）。 */
  private readonly ackWaiters = new Map<string, AckWaiter>();
  /**
   * 待ち手より先に届いた ack（waiter が既にタイムアウトした / まだ登録されていない）を
   * 一時保持する。メモリ無限増加を防ぐため FIFO で上限個に丸める。
   */
  private readonly orphanAcked = new Set<number>();
  private static readonly ORPHAN_ACK_CAP = 4096;

  /**
   * live 判定の既定時間窓（ms）。ブリッジの long-poll timeout（既定 25s）＋再接続の余裕。
   * この時間内に一度も subscribe（long-poll 接続）が来ていなければ「ブリッジは死んでいる」とみなす。
   */
  static readonly DEFAULT_LIVENESS_WINDOW_MS = 40_000;

  constructor(private readonly livenessWindowMs = Mailbox.DEFAULT_LIVENESS_WINDOW_MS) {}

  /** 一度でも subscribe（購読の長poll接続）が来た id か。※配送ゲートには使わない（isLive を使う）。 */
  everSubscribed(id: string): boolean {
    return this.subscribed.has(id);
  }

  /**
   * 現在 live（直近 livenessWindowMs 以内に long-poll 接続があった）か。
   * = そのエビの制御MCP ブリッジが生きて購読を張り続けているか。
   * これを notification 配送の可否ゲートに使う（everSubscribed の単調フラグ問題を解消）。
   * 現在待機中の waiter があれば当然 live。
   */
  isLive(id: string, nowMs = Date.now()): boolean {
    if (this.waiters.has(id)) return true;
    const last = this.lastPollAt.get(id);
    return last !== undefined && nowMs - last < this.livenessWindowMs;
  }

  /**
   * メッセージを push する。採番した seq id を返す（ack 相関・可視化用）。
   * 待機中の long-poll があれば即時 resolve して届ける。
   * 無ければ pending キューへ積み、次の subscribe() 呼び出しで回収される
   * （購読の谷間で push されても取りこぼさない = long-poll 再接続のギャップに強い）。
   */
  push(id: string, msg: Omit<MailboxMessage, "id"> & { id?: number }): number {
    const seqId = msg.id ?? ++this.seq;
    const full: MailboxMessage = { ...msg, id: seqId };
    const waiter = this.waiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.resolve([full]);
      return seqId;
    }
    const q = this.pending.get(id) ?? [];
    q.push(full);
    this.pending.set(id, q);
    return seqId;
  }

  /**
   * long-poll 購読。
   * pending が既にあれば即座にそれを返す（消費して空にする）。
   * 無ければ最大 timeoutMs 待ち、その間に push があればそれを返す。
   * timeout したら空配列を返す（ブリッジ側は空配列を受けたら即再接続するループを回す）。
   * 同一 id で二重に subscribe された場合、古い方は空配列で即解決してから差し替える
   * （ブリッジの再接続レース対策）。
   */
  subscribe(id: string, timeoutMs: number): Promise<MailboxMessage[]> {
    this.subscribed.add(id);
    this.lastPollAt.set(id, Date.now());

    const q = this.pending.get(id);
    if (q && q.length > 0) {
      this.pending.delete(id);
      return Promise.resolve(q);
    }

    const existing = this.waiters.get(id);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve([]);
    }

    return new Promise<MailboxMessage[]>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve([]);
      }, timeoutMs);
      this.waiters.set(id, { resolve, timer });
    });
  }

  /**
   * ブリッジからの到達確認（end-to-end ACK）。
   * ブリッジは subscribe で受け取ったメッセージを `notifications/claude/channel` として emit した
   * 「後」に、その seq id 群を ack() で返す。これにより「ブリッジが生きていてメッセージを
   * セッションへ確かに転送した」ことが確認できる（push しただけの楽観 delivered との決別）。
   */
  ack(id: string, msgIds: number[]): void {
    for (const msgId of msgIds) {
      const key = `${id} ${msgId}`;
      const w = this.ackWaiters.get(key);
      if (w) {
        clearTimeout(w.timer);
        this.ackWaiters.delete(key);
        w.resolve(true);
      } else {
        // 待ち手がまだ / もう居ない ack。短期保持して、後から来る waitForAck を満たす。
        if (this.orphanAcked.size >= Mailbox.ORPHAN_ACK_CAP) {
          const first = this.orphanAcked.values().next().value;
          if (first !== undefined) this.orphanAcked.delete(first);
        }
        this.orphanAcked.add(msgId);
      }
    }
  }

  /**
   * 指定メッセージ（seq id）の ACK を最大 timeoutMs 待つ。
   * 既に ack 済み（orphanAcked に居る）なら即 true。timeout したら false（呼び出し側は
   * PTY フォールバックする）。
   */
  waitForAck(id: string, msgId: number, timeoutMs: number): Promise<boolean> {
    if (this.orphanAcked.delete(msgId)) return Promise.resolve(true);
    const key = `${id} ${msgId}`;
    // 同一 key の既存待ちは掃除（通常起きないが安全側）。
    const prev = this.ackWaiters.get(key);
    if (prev) {
      clearTimeout(prev.timer);
      this.ackWaiters.delete(key);
      prev.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(key);
        resolve(false);
      }, timeoutMs);
      this.ackWaiters.set(key, { resolve, timer });
    });
  }

  /**
   * pending から指定 seq id のメッセージを取り出して除去する（PTY フォールバック時に
   * 「まだブリッジに拾われていない」メッセージを二重配送しないよう回収するために使う）。
   * 見つからなければ null（＝既にブリッジが拾って emit 済み or 存在しない）。
   */
  take(id: string, msgId: number): MailboxMessage | null {
    const q = this.pending.get(id);
    if (!q) return null;
    const idx = q.findIndex((m) => m.id === msgId);
    if (idx < 0) return null;
    const [msg] = q.splice(idx, 1);
    if (q.length === 0) this.pending.delete(id);
    return msg ?? null;
  }

  /** 指定 id の pending 件数。 */
  pendingCount(id: string): number {
    return this.pending.get(id)?.length ?? 0;
  }

  /**
   * pending（未回収）メッセージ全体の可視化スナップショット。
   * 「黙って消えていない」ことを master / UI / 運用者が観測するための入口。
   */
  pendingSnapshot(nowMs = Date.now()): PendingSnapshotEntry[] {
    const out: PendingSnapshotEntry[] = [];
    for (const [id, q] of this.pending) {
      if (q.length === 0) continue;
      const oldest = q[0]?.ts;
      out.push({
        id,
        count: q.length,
        live: this.isLive(id, nowMs),
        oldestAgeMs: oldest !== undefined ? nowMs - oldest : null,
      });
    }
    return out;
  }

  /**
   * id が subscribe 済み（everSubscribed）になるまで最大 timeoutMs 待つ（spawn 直後用）。
   * 既に済みなら即 true。ポーリング間隔 100ms の簡易実装（頻度・母数的に十分軽い）。
   */
  async waitForSubscriber(id: string, timeoutMs: number): Promise<boolean> {
    if (this.subscribed.has(id)) return true;
    const start = Date.now();
    const POLL_MS = 100;
    while (Date.now() - start < timeoutMs) {
      await new Promise<void>((r) => setTimeout(r, POLL_MS));
      if (this.subscribed.has(id)) return true;
    }
    return this.subscribed.has(id);
  }

  /**
   * agent 破棄（kill/exit）時のクリーンアップ。
   * 待機中の long-poll があれば空配列で解決し（ブリッジ側の fetch を詰まらせない）、
   * pending・subscribed・liveness・ack 待ち状態も破棄する（agent が消えたので届けようがない）。
   * 破棄した pending メッセージ（＝配送できずに消えるもの）を返す（呼び出し側でログ/notice 化して
   * 「黙って失われた」を可視化するため）。
   */
  clear(id: string): MailboxMessage[] {
    const dropped = this.pending.get(id) ?? [];
    this.pending.delete(id);
    const w = this.waiters.get(id);
    if (w) {
      clearTimeout(w.timer);
      this.waiters.delete(id);
      w.resolve([]);
    }
    this.subscribed.delete(id);
    this.lastPollAt.delete(id);
    // この id 宛の ack 待ちも全て false 解決して破棄する。
    for (const [key, aw] of this.ackWaiters) {
      if (key.startsWith(`${id} `)) {
        clearTimeout(aw.timer);
        this.ackWaiters.delete(key);
        aw.resolve(false);
      }
    }
    return dropped;
  }
}
