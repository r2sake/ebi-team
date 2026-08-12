// broadcast された notice の直近履歴（リングバッファ）。
//
// 【2026-08-12 master 起動不能インシデント】
// 固定エビの再起動 notice / crashloop 停止 notice は broadcast のみで、接続中のクライアントが
// 居なければ誰にも届かなかった。master は約 15 秒で crashloop 停止まで行くため、ブラウザを
// 開く頃には通知が流れ終わっており「何も起きていない」ように見えた。
//
// そこでサーバ側で直近の notice を保持し、新規 WebSocket 接続時に replay する。
// 揮発（プロセス内メモリのみ）で十分＝恒久追跡は fixedEbiLog / deliveryLog が担う。

/** 保持する 1 件の notice。 */
export interface NoticeEntry {
  id: string;
  text: string;
  /** 発生時刻（epoch ms）。replay 時にクライアントが当時の時刻を表示するために使う。 */
  ts: number;
}

/** 既定の保持件数（クライアント側の notice 表示上限 50 件と揃える）。 */
export const DEFAULT_NOTICE_BUFFER_SIZE = 50;

/** 直近 N 件の notice を保持するリングバッファ。 */
export class NoticeBuffer {
  private readonly entries: NoticeEntry[] = [];

  constructor(private readonly capacity: number = DEFAULT_NOTICE_BUFFER_SIZE) {}

  /** notice を追加する（上限超過分は古い順に捨てる）。capacity <= 0 なら何も保持しない。 */
  push(id: string, text: string, ts: number = Date.now()): void {
    if (this.capacity <= 0) return;
    this.entries.push({ id, text, ts });
    while (this.entries.length > this.capacity) this.entries.shift();
  }

  /** 古い順の一覧（replay 用）。 */
  list(): NoticeEntry[] {
    return [...this.entries];
  }

  /** 保持件数。 */
  get size(): number {
    return this.entries.length;
  }
}
