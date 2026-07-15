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

/** mailbox に積む/配送する 1 件のメッセージ。 */
export interface MailboxMessage {
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

/**
 * エビ id ごとの pending キュー + long-poll 購読を管理する。
 *
 * - push: 待機中の long-poll があれば即時 resolve、無ければ pending へ積む（順序保持）。
 * - subscribe: pending があれば即返す。無ければ最大 timeoutMs 待って push を待つ（無ければ空配列）。
 * - everSubscribed: 一度でも subscribe() が呼ばれた id か（= ブリッジが生きて購読を張ったことがある）。
 *   これを「notification 経路が使える宛先か」の判定に使う（Registry 側）。
 */
export class Mailbox {
  private readonly pending = new Map<string, MailboxMessage[]>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly subscribed = new Set<string>();

  /** 一度でも subscribe（購読の長poll接続）が来た id か。 */
  everSubscribed(id: string): boolean {
    return this.subscribed.has(id);
  }

  /**
   * メッセージを push する。
   * 待機中の long-poll があれば即時 resolve して届ける。
   * 無ければ pending キューへ積み、次の subscribe() 呼び出しで回収される
   * （購読の谷間で push されても取りこぼさない = long-poll 再接続のギャップに強い）。
   */
  push(id: string, msg: MailboxMessage): void {
    const waiter = this.waiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.resolve([msg]);
      return;
    }
    const q = this.pending.get(id) ?? [];
    q.push(msg);
    this.pending.set(id, q);
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
   * pending・subscribed 状態も破棄する（agent が消えたので届けようがない）。
   */
  clear(id: string): void {
    this.pending.delete(id);
    const w = this.waiters.get(id);
    if (w) {
      clearTimeout(w.timer);
      this.waiters.delete(id);
      w.resolve([]);
    }
    this.subscribed.delete(id);
  }
}
