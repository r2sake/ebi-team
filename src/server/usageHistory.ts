// レート制限使用率（rate_limits）の恒久ログ（JSONL 追記）と、その集計。
//
// 【背景 2026-09-05】
// UsageStore は各エビの statusLine から rate_limits.five_hour / seven_day の used_percentage を
// 受け取っているが、これまで in-memory の latest 保持のみで永続化がゼロだった。そのため
// 「先週はどれくらい枠を使ったのか」を後から一切追えない（サーバ再起動で消える）。
// ここでは受信値が変わったときだけ 1 行追記し、直近 7 日の週次消費率を集計できるようにする。
//
// 方針（jsonlLog.ts と同じ best-effort 思想。ただし console には出さない＝毎分の statusLine で
// ターミナルを埋めないため）:
// - 書き込み失敗で本業（usage 配信）を止めない。
// - 追記は直列化して行の混線を防ぐ。
// - サイズ上限を超えたら 1 世代だけローテートする（`<path>.1`）。集計はローテート先も読む。
// - configure されるまでファイルへは書かない（ユニットテストが勝手にファイルを作らないため）。

import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** 記録対象のレート制限枠。statusLine JSON のキー名をそのまま使う。 */
export type UsageWindow = "five_hour" | "seven_day";

/** JSONL 1 行分のレコード。 */
export interface UsageHistoryRecord {
  /** 受信時刻（ISO8601）。 */
  ts: string;
  /** 受信時刻（epoch ms）。集計はこちらを使う。 */
  receivedAt: number;
  /** 値を運んできたエビの id（rate_limits 自体はアカウント単位）。 */
  ebiId: string;
  /** そのエビの model（display_name か id。不明なら null）。 */
  model: string | null;
  /** レート制限枠。 */
  window: UsageWindow;
  /** 使用率（%）。 */
  usedPct: number;
  /** 枠のリセット時刻（statusLine が返す epoch 秒をそのまま保持）。 */
  resetsAt: number;
}

/** ローテートするサイズ上限（bytes）。1 行 ~150B・変化時のみ追記なので既定 4MB で数万行入る。 */
const MAX_BYTES = Number(process.env.EBI_USAGE_HISTORY_MAX_BYTES) || 4 * 1024 * 1024;

let path: string | null = null;
let writtenBytes = 0;
/** 追記の直列化チェーン（行の混線防止）。 */
let chain: Promise<void> = Promise.resolve();

/**
 * 出力先を設定する（サーバ起動時に一度だけ呼ぶ）。
 * null を渡すと以降ファイルへは書かない（＝記録 OFF）。
 */
export function configureUsageHistory(p: string | null): void {
  path = p;
  writtenBytes = 0;
  if (!p) return;
  // 既存ファイルのサイズを引き継いでローテート判定に使う（起動のたびに 0 に戻さない）。
  chain = chain
    .then(async () => {
      await mkdir(dirname(p), { recursive: true });
      const st = await stat(p).catch(() => null);
      writtenBytes = st?.size ?? 0;
    })
    .catch(() => {});
}

/** 現在の出力先（未設定なら null）。起動ログ表示用。 */
export function usageHistoryPath(): string | null {
  return path;
}

/**
 * 1 件追記する。呼び出し側は await しない（best-effort・usage 受信のレイテンシに載せない）。
 * 「値が変わったときだけ呼ぶ」の判定は UsageStore 側の責務。
 */
export function recordUsageHistory(rec: UsageHistoryRecord): void {
  const target = path;
  if (!target) return;
  const buf = `${JSON.stringify(rec)}\n`;
  chain = chain
    .then(async () => {
      if (writtenBytes + buf.length > MAX_BYTES) {
        await rename(target, `${target}.1`).catch(() => {});
        writtenBytes = 0;
      }
      await appendFile(target, buf, "utf8");
      writtenBytes += buf.length;
    })
    .catch((err) => {
      // ログの失敗でチェーンを壊さない（以降の書き込みは続行する）。
      console.warn("[usage-history] 記録の書き込みに失敗:", (err as Error).message);
    });
}

/** テスト用: 追記チェーンの完了を待つ（本番経路では使わない）。 */
export function flushUsageHistory(): Promise<void> {
  return chain;
}

/**
 * JSONL（＋ローテート先 `<path>.1`）を読み、壊れた行は捨ててレコード配列にする。
 * ファイルが無ければ空配列（まだ 1 度も記録していない状態は異常ではない）。
 */
export async function readUsageHistory(p: string): Promise<UsageHistoryRecord[]> {
  const out: UsageHistoryRecord[] = [];
  // 古い順に読む（.1 が先）。
  for (const f of [`${p}.1`, p]) {
    const text = await readFile(f, "utf8").catch(() => null);
    if (text === null) continue;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as UsageHistoryRecord;
        if (
          typeof rec?.receivedAt === "number" &&
          typeof rec?.usedPct === "number" &&
          (rec.window === "five_hour" || rec.window === "seven_day")
        ) {
          out.push(rec);
        }
      } catch {
        // 壊れた行は無視（書き込み中断など）。
      }
    }
  }
  return out;
}

/** 集計結果。対象レコードが 0 件なら max/median は null。 */
export interface UsageSummary {
  window: UsageWindow;
  /** 集計対象の期間（epoch ms）。 */
  from: number;
  to: number;
  /** 対象レコード数。 */
  count: number;
  /** 使用率の最大（%）。 */
  maxPct: number | null;
  /** 使用率の中央値（%）。偶数件は中央 2 値の平均。 */
  medianPct: number | null;
  /** 最新レコード（対象期間内）。 */
  latest: UsageHistoryRecord | null;
}

/**
 * 指定枠・指定期間の使用率の最大／中央値を出す純関数（集計スクリプトとテストの共有点）。
 * @param records readUsageHistory の結果（順不同で可）。
 * @param window 対象枠。
 * @param from 期間の下限（epoch ms・以上）。
 * @param to 期間の上限（epoch ms・以下）。
 */
export function summarizeUsage(
  records: UsageHistoryRecord[],
  window: UsageWindow,
  from: number,
  to: number,
): UsageSummary {
  const hit = records
    .filter((r) => r.window === window && r.receivedAt >= from && r.receivedAt <= to)
    .sort((a, b) => a.receivedAt - b.receivedAt);
  if (hit.length === 0) {
    return { window, from, to, count: 0, maxPct: null, medianPct: null, latest: null };
  }
  const pcts = hit.map((r) => r.usedPct).sort((a, b) => a - b);
  const mid = pcts.length >> 1;
  const medianPct =
    pcts.length % 2 === 1 ? pcts[mid]! : (pcts[mid - 1]! + pcts[mid]!) / 2;
  return {
    window,
    from,
    to,
    count: hit.length,
    maxPct: pcts[pcts.length - 1]!,
    medianPct,
    latest: hit[hit.length - 1]!,
  };
}
