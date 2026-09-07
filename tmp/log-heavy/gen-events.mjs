// 実ログ（.ebi-team/master-chat.jsonl）から計測用の末尾 N 件 JSON を作る。
import { readFileSync, writeFileSync } from "node:fs";
const all = [];
for (const l of readFileSync(".ebi-team/master-chat.jsonl", "utf8").split("\n")) {
  if (!l.trim()) continue;
  try { all.push(JSON.parse(l)); } catch { /* 壊れた行は読み捨てる */ }
}
for (const n of [400, 1000, 4000, all.length]) {
  writeFileSync(`tmp/log-heavy/events-${n}.json`, JSON.stringify(all.slice(-n)));
}
console.log("生成:", all.length, "件");
