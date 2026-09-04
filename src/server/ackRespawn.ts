// 役割プロンプト ACK の「静かな故障」に対する判断（純関数）。
//
// 検知そのものは agent.ts（PTY 出力の走査）＋ backends/profiles.ts（正規表現の SoT）が担い、
// 実際の kill / 再 spawn / 通知は index.ts が行う。その間に挟まる**判断だけ**をここに置く
// （プロセスを起動せずに「1 回しか作り直さない」「2 回目は fatal 通知」を単体テストで固定するため）。

/** 静かな故障を検知したときに取る行動。 */
export type AckFailureAction =
  /** kill →同一 id・同一引数で 1 回だけ作り直す。 */
  | "respawn"
  /** 作り直し済みなのでもう作り直さない。fatal として master へ通知する。 */
  | "fatal"
  /** 何もしない（既に片付いている・エビが消えている等の遅延イベント）。 */
  | "ignore";

/** 判断に必要な状態。 */
export interface AckFailureContext {
  /** 作り直し用に控えた spawn 引数が残っているか（無い＝処理済み or 対象外 backend）。 */
  readonly hasParams: boolean;
  /** そのエビがまだ registry に居るか（kill 済みなら何もしない）。 */
  readonly agentAlive: boolean;
  /** この spawn 自体が「静かな故障による作り直し」の結果か。 */
  readonly isRetry: boolean;
}

/**
 * 静かな故障の検知に対する行動を決める。
 *
 * - 作り直しは **1 エビにつき 1 回だけ**（isRetry の spawn は二度と作り直さない＝無限ループ防止）。
 * - 2 回目は fatal。黙って idle のまま放置しない（master から「起動しているのに報告が来ない」に
 *   見えるのが、この機構が潰そうとしている故障そのもの）。
 * - 引数を控えていない／エビが既に居ない場合は何もしない（遅延イベントの取りこぼし対策）。
 */
export function decideAckFailureAction(ctx: AckFailureContext): AckFailureAction {
  if (!ctx.hasParams || !ctx.agentAlive) return "ignore";
  return ctx.isRetry ? "fatal" : "respawn";
}

/** 2 回目の故障を master へ知らせる本文（reverseInject で送る）。 */
export function buildAckFatalMessage(id: string, backendId: string, reason: string): string {
  return (
    `【fatal】${id}（backend=${backendId}）は作り直し後も役割プロンプトへの応答で` +
    `「${reason}」となりました（静かな故障・2 回目）。このエビは reply_to_master を使えないため、` +
    `依頼したタスクは未実行です。別 backend（claude）で振り直してください。`
  );
}
