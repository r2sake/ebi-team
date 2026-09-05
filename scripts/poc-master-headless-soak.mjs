// PR-M0 PoC（放置観測）: claude ヘッドレス master を 1 プロセスのまま生かし続け、
// 一定間隔で 1 ターン投げて「サブスク OAuth が切れないか（authentication_failed が出ないか）」
// 「文脈占有量が単調に伸びるか」を観測する。設計書 §8-R1 の 24h 観測用。
//
//   POC_SOAK_MINUTES=360 POC_SOAK_INTERVAL_MIN=30 node scripts/poc-master-headless-soak.mjs
//
// 既定は 15 分 / 5 分間隔（短時間の動作確認用）。稼働 control API には触らない（MCP なしで起動）。
import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = process.env.POC_OUT ?? join(ROOT, "tmp", "poc-m0-soak");
const TOTAL_MIN = Number(process.env.POC_SOAK_MINUTES ?? 15);
const INTERVAL_MIN = Number(process.env.POC_SOAK_INTERVAL_MIN ?? 5);
mkdirSync(OUT, { recursive: true });
// 出力名はリポジトリの .gitignore（*.log）に掛からないよう .log.txt にする（証跡を残すため）
const LOG = join(OUT, "soak.log.txt");
const STDERR_LOG = join(OUT, "soak.stderr.log.txt");
const FINDINGS = join(OUT, "soak-findings.json");
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); appendFileSync(LOG, l + "\n"); };

// 親（起動シェル）が死んでも観測を続ける。nohup / setsid 起動と併用する。
process.on("SIGHUP", () => log("SIGHUP 受信（無視して観測を継続）"));

const env = { ...process.env };
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete env[k];

const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--replay-user-messages", "--permission-mode", "auto", "--model", "opus",
  "--append-system-prompt", "あなたは ebi-team の master です。1 行で簡潔に答えてください。"];
// detached: 端末のプロセスグループ宛シグナルで claude が巻き添えで死なないよう分離する
const p = spawn("claude", args, { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
log(`spawn pid=${p.pid} total=${TOTAL_MIN}min interval=${INTERVAL_MIN}min`);

const events = [];
const samples = [];
let lastCtx = null;
createInterface({ input: p.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  appendFileSync(join(OUT, "soak.ndjson"), line + "\n");
  let e; try { e = JSON.parse(line); } catch { return; }
  events.push(e);
  if (e.type === "assistant" && e.message?.usage) {
    const u = e.message.usage;
    lastCtx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
});
p.stderr.on("data", (d) => appendFileSync(STDERR_LOG, String(d)));
p.on("exit", (c, s) => log(`EXIT code=${c} sig=${s}`));

const start = Date.now();
let n = 0;

// 中断されても直前までのサンプルが残るよう、ping ごとに上書き保存する
function saveFindings(status) {
  writeFileSync(FINDINGS, JSON.stringify({
    status, totalMin: TOTAL_MIN, intervalMin: INTERVAL_MIN,
    startedAt: new Date(start).toISOString(), updatedAt: new Date().toISOString(),
    pid: process.pid, claudePid: p.pid, samples,
  }, null, 2) + "\n");
}
async function ping() {
  n++;
  const before = events.length;
  p.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: `soak ping #${n}。現在時刻の所感は不要です。「OK ${n}」とだけ返してください。` }] } }) + "\n");
  const t = Date.now();
  const deadline = t + 180000;
  while (Date.now() < deadline) {
    const r = events.slice(before).find((e) => e.type === "result");
    if (r) {
      const s = {
        n, atMin: Math.round((Date.now() - start) / 6000) / 10,
        subtype: r.subtype, isError: r.is_error, latencyMs: Date.now() - t,
        contextTokens: lastCtx, cumulativeCostUsd: r.total_cost_usd,
        apiErrorStatus: r.api_error_status ?? null, text: String(r.result ?? "").slice(0, 80),
      };
      samples.push(s);
      saveFindings("running");
      log(`ping#${n}: ${JSON.stringify(s)}`);
      // 認証系エラーの検出（サブスク OAuth 失効の一次シグナル）
      const errs = events.slice(before).filter((e) => JSON.stringify(e).includes("authentication_failed"));
      if (errs.length) log(`!! authentication_failed 検出: ${JSON.stringify(errs).slice(0, 500)}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  samples.push({ n, timeout: true, atMin: Math.round((Date.now() - start) / 6000) / 10 });
  saveFindings("running");
  log(`ping#${n}: TIMEOUT`);
}

// 停止要求（kill $(cat soak.pid)）でも findings を残してから claude を落とす
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log(`${sig} 受信: findings を保存して終了する`);
    saveFindings("stopped");
    try { p.kill("SIGKILL"); } catch {}
    process.exit(0);
  });
}

saveFindings("starting");
await ping();
const timer = setInterval(async () => {
  if ((Date.now() - start) / 60000 >= TOTAL_MIN) {
    clearInterval(timer);
    saveFindings("completed");
    log(`done -> ${FINDINGS}`);
    p.kill("SIGKILL");
    process.exit(0);
  }
  await ping();
}, INTERVAL_MIN * 60 * 1000);
