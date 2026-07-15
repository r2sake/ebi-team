import type { AgentStatus } from "../shared/protocol.ts";

/**
 * idle/busy 判定器（ヒューリスティック）。
 *
 * MVP の判定方針:
 *   PTY 出力があった瞬間に busy とみなし、出力が一定時間（idleThresholdMs）
 *   止まったら idle に戻す。確実な検知は難しいため「動いている間は注入を保留し、
 *   落ち着いたら流す」を満たすことを目的とする。
 *
 * より正確な検知（プロンプト文字列のパターンマッチ、claude の状態行解析など）に
 * 差し替えやすいよう、本クラスに判定ロジックを閉じ込めている。
 * 差し替えポイント = このクラスを別実装に置き換える / notifyOutput の中身を変える。
 */
export class IdleDetector {
  private status: AgentStatus = "idle";
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly idleThresholdMs: number,
    /** idle へ遷移した瞬間に呼ばれる。 */
    private readonly onIdle: () => void,
    /** busy へ遷移した瞬間に呼ばれる。 */
    private readonly onBusy: () => void,
  ) {}

  /** PTY から出力が来たら呼ぶ。busy 化し、idle タイマを再武装する。 */
  notifyOutput(): void {
    if (this.status !== "busy") {
      this.status = "busy";
      this.onBusy();
    }
    this.armIdleTimer();
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  private armIdleTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.status !== "idle") {
        this.status = "idle";
        this.onIdle();
      }
    }, this.idleThresholdMs);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
