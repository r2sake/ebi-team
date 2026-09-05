#!/usr/bin/env node
// 直近 7 日の週次消費率（rate_limits.seven_day の used_percentage）の最大／中央値を出す。
//
// 入力は usage-history.jsonl（UsageStore が値の変化時のみ追記するもの）。
// 使い方:
//   npm run usage:report
//   npm run usage:report -- --days 14 --path /path/to/usage-history.jsonl
//
// tsx 経由で起動しているのは、集計の純関数（summarizeUsage）をサーバ実装と共有するため。

import { join } from "node:path";
import { readUsageHistory, summarizeUsage } from "../src/server/usageHistory.ts";

function parseArgs(argv) {
  const out = { days: 7, path: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") out.days = Number(argv[++i]);
    else if (argv[i] === "--path") out.path = argv[++i];
  }
  if (!Number.isFinite(out.days) || out.days <= 0) {
    console.error("--days は正の数で指定してください");
    process.exit(2);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const path =
  args.path ??
  process.env.EBI_USAGE_HISTORY_PATH ??
  join(process.cwd(), ".ebi-team", "usage-history.jsonl");

const records = await readUsageHistory(path);
const to = Date.now();
const from = to - args.days * 24 * 60 * 60 * 1000;
const sum = summarizeUsage(records, "seven_day", from, to);

const fmt = (n) => (n === null ? "-" : `${n.toFixed(1)}%`);
const jst = (ms) => new Date(ms).toLocaleString("ja-JP");

console.log(`使用率履歴: ${path}（全 ${records.length} 行）`);
console.log(`集計期間: 直近 ${args.days} 日（${jst(from)} 〜 ${jst(to)}）`);
console.log(`対象レコード（seven_day）: ${sum.count} 件`);
console.log(`週次消費率 最大: ${fmt(sum.maxPct)}`);
console.log(`週次消費率 中央値: ${fmt(sum.medianPct)}`);
if (sum.latest) {
  console.log(
    `最新: ${fmt(sum.latest.usedPct)}（${jst(sum.latest.receivedAt)} / ${sum.latest.ebiId} / ${sum.latest.model ?? "model 不明"}）`,
  );
}
if (sum.count === 0) {
  console.log("（記録がありません。サーバが起動して statusLine を受けているか確認してください）");
}
