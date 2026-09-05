// PoC: Gemini CLI を node-pty 上で ebi-team(agent.ts) と同じ流儀で駆動できるかの検証スクリプト（使い捨て）。
//
// 検証項目:
//   a. alt-screen へ入らないか（ESC[?1049h の有無）
//   b. 「本文 write → ENTER_DELAY ms → \r」で送信が成立するか（ACK 往復の成功率）
//   c. 起動〜プロンプト待ちでダイアログ（起動ゲート）が出ないか（生バイト列を保存）
//   d. アイドル時に PTY 出力が完全に止まるか（IdleDetector が idle に落ちるか）
//
// 使い方: node poc-gemini-pty.mjs --enter-delay 500 --rounds 10 --idle-observe 60
import pty from "node-pty";
import { writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const ENTER_DELAY_MS = Number(arg("enter-delay", 500));
const ROUNDS = Number(arg("rounds", 10));
const IDLE_OBSERVE_SEC = Number(arg("idle-observe", 60));
const IDLE_THRESHOLD_MS = Number(arg("idle-ms", 900)); // src/server/index.ts の既定と同じ
const OUT_DIR = arg("out", process.cwd());
const RAW_LOG = join(OUT_DIR, `pty-raw-${ENTER_DELAY_MS}ms.log`);
const MODEL = arg("model", "gemini-2.5-flash");
const SETTINGS = arg("settings", "");

writeFileSync(RAW_LOG, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) =>
  s.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b[()][A-Z0-9]/g, "");

// --- env: ebi-team の buildSpawnEnv 相当 + envDenyList の検証 ---
const env = { ...process.env };
const DENY = String(arg("deny", "GEMINI_API_KEY,GOOGLE_API_KEY,GOOGLE_GENAI_USE_VERTEXAI,GOOGLE_GENAI_USE_GCA,GOOGLE_APPLICATION_CREDENTIALS"))
  .split(",").filter(Boolean);
for (const k of DENY) delete env[k];
if (SETTINGS) env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = SETTINGS;

const args = ["-m", MODEL, "--approval-mode", "yolo"];
if (SETTINGS) args.push("--allowed-mcp-server-names", "ebi-control");
const initial = arg("initial", "");
if (initial) args.push("-i", initial);

console.log(`[poc] spawn: gemini ${args.join(" ")}`);
console.log(`[poc] deny=${DENY.join(",")} / GOOGLE_CLOUD_PROJECT=${env.GOOGLE_CLOUD_PROJECT ?? "(unset)"}`);

const proc = pty.spawn("gemini", args, {
  name: "xterm-color", cols: 80, rows: 24, cwd: arg("cwd", OUT_DIR), env,
});

let rows = 24;
let plain = "";           // ANSI 除去済みの累積（照合用・末尾のみ保持）
let lastMeaningfulAt = Date.now();
let bytesTotal = 0;
const timeline = [];      // { t, bytes } meaningful 出力の時系列

proc.onData((data) => {
  // DSR/DECXCPR への自動応答（agent.ts answerTerminalQueries と同等）
  if (data.indexOf("\x1b[") !== -1) {
    let reply = "";
    for (const _ of data.matchAll(/\x1b\[\?6n/g)) reply += `\x1b[?${rows};1R`;
    for (const _ of data.matchAll(/\x1b\[6n/g)) reply += `\x1b[${rows};1R`;
    if (reply) proc.write(reply);
  }
  appendFileSync(RAW_LOG, data);
  const meaningful = data.replace(/\x1b\[\??6n/g, "");
  if (meaningful.length === 0) return;
  bytesTotal += meaningful.length;
  lastMeaningfulAt = Date.now();
  timeline.push({ t: Date.now(), bytes: meaningful.length });
  plain = (plain + stripAnsi(meaningful)).slice(-20000);
});

let exited = null;
proc.onExit(({ exitCode }) => { exited = exitCode; });

/** meaningful 出力が idleMs 止まるまで待つ（IdleDetector 相当）。 */
async function waitIdle(idleMs = IDLE_THRESHOLD_MS, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (Date.now() - lastMeaningfulAt >= idleMs) return true;
    await sleep(50);
  }
  return false;
}

/** 本文 write → ENTER_DELAY → \r（agent.ts の注入と同一手順）。 */
async function inject(body) {
  proc.write(body);
  await sleep(ENTER_DELAY_MS);
  proc.write("\r");
}

async function waitFor(needle, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (plain.includes(needle)) return Date.now() - start;
    if (exited !== null) return -1;
    await sleep(100);
  }
  return -1;
}

const report = { enterDelayMs: ENTER_DELAY_MS, model: MODEL, rounds: [], };

(async () => {
  // --- (c) 起動フェーズの観測: プロンプト行が出るまで待つ（沈黙での誤 ready を避ける）---
  const bootT0 = Date.now();
  const promptMs = await waitFor("Type your message", 180000);
  const readyOk = promptMs >= 0 && (await waitIdle(IDLE_THRESHOLD_MS, 60000));
  report.bootPromptMs = promptMs;
  console.log(`[poc] プロンプト出現まで ${promptMs}ms`);
  const bootPlain = plain;
  report.boot = {
    idleReachedWithinMs: readyOk ? Date.now() - bootT0 : null,
    altScreenEnter: /\x1b\[\?1049h/.test(require_raw()),
    bytes: bytesTotal,
    tail: bootPlain.slice(-1200),
  };
  console.log(`[poc] boot: idle到達=${readyOk} bytes=${bytesTotal} altScreen=${report.boot.altScreenEnter}`);

  // --- (d) アイドル観測 ---
  const idleStartBytes = bytesTotal;
  const idleStart = Date.now();
  await sleep(IDLE_OBSERVE_SEC * 1000);
  const idleBytes = bytesTotal - idleStartBytes;
  const idleChunks = timeline.filter((e) => e.t >= idleStart).length;
  const longestSilence = (() => {
    const ev = timeline.filter((e) => e.t >= idleStart).map((e) => e.t);
    let prev = idleStart, max = 0;
    for (const t of ev) { max = Math.max(max, t - prev); prev = t; }
    return Math.max(max, Date.now() - prev);
  })();
  report.idle = { observeSec: IDLE_OBSERVE_SEC, bytes: idleBytes, chunks: idleChunks, longestSilenceMs: longestSilence };
  console.log(`[poc] idle観測 ${IDLE_OBSERVE_SEC}s: bytes=${idleBytes} chunks=${idleChunks} 最長無出力=${longestSilence}ms`);

  // --- タスクモード（--task 指定時は ACK ラウンドを行わず、実タスクを1本流す）---
  const task = arg("task", "");
  const taskMarker = arg("task-marker", "");
  if (task) {
    await waitIdle(IDLE_THRESHOLD_MS, 30000);
    plain = "";
    const t0 = Date.now();
    await inject(task);
    const waitSec = Number(arg("task-wait", 0));
    const ms = taskMarker ? await waitFor(taskMarker, 300000) : (await sleep(waitSec * 1000), -1);
    // タスク完了後のアイドル観測（ターン後に定期再描画が残らないかを見る）
    const postStart = Date.now();
    const postStartBytes = bytesTotal;
    await sleep(Number(arg("post-idle", 60)) * 1000);
    const postBytes = bytesTotal - postStartBytes;
    const postChunks = timeline.filter((e) => e.t >= postStart).length;
    report.postTaskIdle = { observeSec: Number(arg("post-idle", 60)), bytes: postBytes, chunks: postChunks };
    console.log(`[poc] タスク後アイドル観測: bytes=${postBytes} chunks=${postChunks}`);
    report.task = { task, marker: taskMarker, ms, tail: plain.slice(-3000) };
    console.log(`[poc] task: ${ms >= 0 ? "OK " + ms + "ms" : "marker未検出"}`);
    writeFileSync(join(OUT_DIR, `pty-task-${Date.now()}.json`), JSON.stringify(report, null, 2));
    console.log(`[poc] pid=${proc.pid} を終了します`);
    try { proc.kill(); } catch {}
    await sleep(1500);
    process.exit(0);
  }

  // --- (b) 注入テスト ---
  for (let i = 1; i <= ROUNDS; i++) {
    await waitIdle(IDLE_THRESHOLD_MS, 30000);
    const token = `ACK${i}Z`;
    plain = "";
    const t0 = Date.now();
    // エコー（入力行の再描画）に token が現れないよう、token 自体は書かずに組み立てさせる。
    await inject(
      `Output one line only: the letters A,C,K then the digit ${i} then the letter Z, joined with no spaces. No other text.`,
    );
    const ms = await waitFor(token, 120000);
    report.rounds.push({ i, ok: ms >= 0, ms });
    console.log(`[poc] round ${i}: ${ms >= 0 ? "OK " + ms + "ms" : "FAIL"}`);
    if (exited !== null) break;
  }
  const ok = report.rounds.filter((r) => r.ok).length;
  report.summary = `${ok}/${report.rounds.length}`;
  console.log(`[poc] 注入成功率: ${report.summary} (enterDelay=${ENTER_DELAY_MS}ms)`);

  writeFileSync(join(OUT_DIR, `pty-report-${ENTER_DELAY_MS}ms.json`), JSON.stringify(report, null, 2));
  console.log(`[poc] pid=${proc.pid} を終了します`);
  try { proc.kill(); } catch {}
  await sleep(1500);
  process.exit(0);
})();

function require_raw() {
  try { return readFileSync(RAW_LOG, "latin1"); } catch { return ""; }
}
