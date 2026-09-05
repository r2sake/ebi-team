// imagegen の依頼／報告 YAML を投げる前・受け取った後に形だけ確かめる小物 CLI。
//
//   node --import tsx scripts/imagegen-check.mjs job    <file|->
//   node --import tsx scripts/imagegen-check.mjs result <file|->
//   npm run imagegen:check -- job docs/samples/imagegen-job.yaml
//
// 様式の SoT は src/server/imagegen.ts。OK なら 0、様式エラーなら 1 を返す。

import { readFileSync } from "node:fs";

import {
  MAX_IMAGES_PER_JOB,
  parseImagegenJob,
  parseImagegenResult,
  outputFileNames,
  targetImages,
} from "../src/server/imagegen.ts";

const [kind, file] = process.argv.slice(2);
if (kind !== "job" && kind !== "result") {
  console.error("使い方: node --import tsx scripts/imagegen-check.mjs <job|result> <file|->");
  process.exit(2);
}
const text = readFileSync(file === "-" || file === undefined ? 0 : file, "utf8");

try {
  if (kind === "job") {
    const job = parseImagegenJob(text);
    const targets = targetImages(job);
    const total = targets.reduce((a, s) => a + s.count, 0);
    console.log(`OK: job_id=${job.jobId} dest_root=${job.destRoot} 生成 ${total}/${MAX_IMAGES_PER_JOB} 枚`);
    if (job.regenerate !== null) console.log(`  再生成のみ: ${job.regenerate.join(", ")}`);
    for (const spec of targets) {
      console.log(`  - ${spec.id}: ${outputFileNames(spec).join(", ")} (${spec.size ? `${spec.size.width}x${spec.size.height}` : "リサイズなし"})`);
    }
  } else {
    const res = parseImagegenResult(text);
    const ok = res.results.filter((r) => r.status === "ok").length;
    console.log(`OK: job_id=${res.jobId} ${ok}/${res.results.length} ok / ${res.summary}`);
    for (const r of res.results) {
      console.log(`  - ${r.id}: ${r.status}${r.errorCode ? ` (${r.errorCode})` : ""} ${r.path ?? ""}`);
    }
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
