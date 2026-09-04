#!/usr/bin/env node
/**
 * PR0-C: Codex CLI(0.146.0) を PTY 上で駆動できるかの使い捨て PoC。
 * 稼働サーバ(8787)/dist/config は読むだけ。プロセスは終了時に PID 指定で必ず落とす。
 *
 * 使い方: node tmp/poc-codex/poc-codex-pty.mjs [--phase all|boot|inject|idle]
 */
import { createRequire } from "node:module";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const REPO = "/Users/yoimaro/workspace/GitHub/ebi-team";
const require = createRequire(join(REPO, "package.json"));
const pty = require("node-pty");

const OUT = new URL(".", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const RAW = join(OUT, "raw.log");
const EV = join(OUT, "events.jsonl");
writeFileSync(RAW, "");
writeFileSync(EV, "");

const ENTER_DELAY_MS = Number(process.env.EBI_ENTER_DELAY_MS) || 500;
const AGENT_ID = "poc-codex";
const CONTROL = "http://127.0.0.1:8787";

const t0 = Date.now();
const ev = (event, extra = {}) => {
  const line = JSON.stringify({ t: Date.now() - t0, event, ...extra });
  appendFileSync(EV, line + "\n");
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ESC = "\u001b";
const strip = (s) =>
  s
    // OSC (ESC ] ... BEL/ST) と CSI/その他エスケープを落として素文にする
    .replace(new RegExp(ESC + "\\][^\\u0007\\u001b]*(\\u0007|" + ESC + "\\\\)?", "g"), "")
    .replace(new RegExp(ESC + "\\[[0-9;?]*[ -/]*[@-~]", "g"), "")
    .replace(new RegExp(ESC + "[@-Z\\\\-_]", "g"), "")
    .replace(/\r/g, "\n");

const mcpArgs = [
  "-c", `mcp_servers.ebi-control.command="node"`,
  "-c", `mcp_servers.ebi-control.args=["${REPO}/dist/server/mcp/control-server.js"]`,
  "-c", `mcp_servers.ebi-control.cwd="${REPO}"`,
  // MCP ツール呼び出しの承認ダイアログを出さない（-a never では抑止されない・別系統）
  "-c", `mcp_servers.ebi-control.default_tools_approval_mode="approve"`,
  "-c",
  `mcp_servers.ebi-control.env={EBI_CONTROL_URL="${CONTROL}",EBI_MCP_ROLE="engineer",EBI_ID="${AGENT_ID}",EBI_NOTIFY_SUBSCRIBE="off"}`,
];

const INITIAL_PROMPT =
  "これは接続テストです。ツールは使わず、次の一語だけを返してください: READY-0";

const WT = process.cwd();
const args = [
  "--no-alt-screen",
  "-s", "read-only",
  "-a", "never",
  "-c", "disable_paste_burst=true",
  // 起動ゲート除去（~/.codex を汚さずインラインのみで）
  "-c", "check_for_update_on_startup=false",
  "-c", `projects={"${REPO}"={trust_level="trusted"},"${WT}"={trust_level="trusted"}}`,
  ...mcpArgs,
  INITIAL_PROMPT,
];

ev("spawn", { command: "codex", args });

const proc = pty.spawn("codex", args, {
  name: "xterm-color",
  cols: 80,
  rows: 30,
  cwd: process.cwd(),
  env: { ...process.env },
});
ev("pid", { pid: proc.pid });
writeFileSync(join(OUT, "pid.txt"), String(proc.pid));

let raw = "";
let plain = "";
let bytes = 0;
let chunks = 0;
let lastOutAt = Date.now();
proc.onData((d) => {
  raw += d;
  plain += strip(d);
  bytes += Buffer.byteLength(d, "utf8");
  chunks++;
  lastOutAt = Date.now();
  appendFileSync(RAW, d);
});
proc.onExit((e) => ev("exit", e));

/** 直近の出力停止（quiet ms）を待つ = IdleDetector 相当の idle 判定。 */
async function waitQuiet(quietMs, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (Date.now() - lastOutAt >= quietMs) return Date.now() - start;
    await sleep(50);
  }
  return -1;
}

async function waitFor(re, timeoutMs, fromIdx) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (re.test(plain.slice(fromIdx))) return Date.now() - start;
    await sleep(100);
  }
  return -1;
}

async function inject(text) {
  proc.write(text);
  await sleep(ENTER_DELAY_MS);
  proc.write("\r");
}

const results = { version: "0.146.0", enterDelayMs: ENTER_DELAY_MS, injections: [] };

async function main() {
  // ---- (1) 起動ゲート / alt-screen / 初回プロンプト ----
  const bootQuiet = await waitQuiet(2500, 120000);
  results.boot = {
    quietAfterMs: bootQuiet,
    altScreenEnter: raw.includes("[?1049h"),
    mouseReport: /\[\?100[0-9]h/.test(raw),
    bracketedPaste: raw.includes("[?2004h"),
    bytes,
    chunks,
  };
  results.boot.initialPromptEchoed = /READY-0/.test(plain);
  results.boot.initialPromptNote = "READY-0 は composer エコーにも出るため、boot-plain.txt を目視で確認する";
  ev("boot", results.boot);

  // 起動ゲートらしき文言の検出
  const gatePat =
    /(trust|Trust|信頼|allow|Allow|approve|承認|y\/n|\[1\]|1\. Yes|Do you want)/;
  results.boot.gateSuspect = gatePat.test(plain.slice(0, 8000));
  writeFileSync(join(OUT, "boot-plain.txt"), plain.slice(0, 12000));

  // ---- (2) MCP 経由 reply_to_master ----
  // 注意: 打ち込んだ本文は composer にエコーされるため、判定語は「プロンプトに現れない形」で
  // 作らせる（例: M-C-P-O-K を連結させて MCPOK と答えさせる）。
  const NONCE = String(Date.now()).slice(-6);
  {
    const from = plain.length;
    const st = Date.now();
    await inject(
      "ebi-control の reply_to_master ツールを1回だけ呼び、message には次の文字列を入れて送ってください: " +
        `\u005bpoc-codex\u005d Codex PoC 疎通確認（PR0-C） nonce=${NONCE}` +
        "。送信できたら、M-C-P-O-K の5文字をハイフン無しで連結した語だけを返してください。",
    );
    const submitted = await waitFor(/esc to interrupt|Working|interrupt/, 15000, from);
    const hit = await waitFor(/MCPOK/, 240000, from);
    results.mcp = {
      nonce: NONCE,
      submittedMs: submitted,
      ms: Date.now() - st,
      answered: hit >= 0,
      sawToolName: /reply_to_master/.test(plain.slice(from)),
    };
    ev("mcp", results.mcp);
    await waitQuiet(2500, 30000);
  }

  // ---- (3) 注入 10 連（本文 write → 遅延 → \r）----
  // 判定: (i) 送信された＝working インジケータが出る (ii) 応答が返る＝PONG-<i>（プロンプトは PONG-X）
  for (let i = 1; i <= 10; i++) {
    const from = plain.length;
    const st = Date.now();
    await inject(`ツールは使わず、次の語の X を ${i} に置き換えた語だけを返してください: PONG-X`);
    const submitted = await waitFor(/esc to interrupt|Working|interrupt/, 15000, from);
    const hit = await waitFor(new RegExp(`PONG-${i}\\b`), 120000, from);
    const r = { n: i, submitted: submitted >= 0, answered: hit >= 0, ms: Date.now() - st };
    results.injections.push(r);
    ev("inject", r);
    await waitQuiet(2000, 20000);
  }
  results.injectSubmitted = results.injections.filter((r) => r.submitted).length;
  results.injectAnswered = results.injections.filter((r) => r.answered).length;

  // ---- (4) read タスク 1本（所要時間） ----
  {
    const from = plain.length;
    const st = Date.now();
    await inject(
      `${process.cwd()}/src/server/idleDetector.ts を読んで、何をするクラスか2文で要約し、` +
        `末尾に READ-DONE と書いてください。`,
    );
    const hit = await waitFor(/READ-DONE/, 180000, from);
    results.readTask = { ok: hit >= 0, ms: Date.now() - st };
    ev("readTask", results.readTask);
    await waitQuiet(2000, 30000);
  }

  // ---- (5) idle 観測 60 秒（無入力） ----
  {
    const b0 = bytes;
    const c0 = chunks;
    const samples = [];
    for (let s = 0; s < 12; s++) {
      const bb = bytes;
      await sleep(5000);
      samples.push({ sec: (s + 1) * 5, bytes: bytes - bb });
    }
    results.idle60 = {
      totalBytes: bytes - b0,
      totalChunks: chunks - c0,
      samples,
      quietMsAtEnd: Date.now() - lastOutAt,
      idleAt900ms: Date.now() - lastOutAt >= 900,
    };
    ev("idle60", results.idle60);
  }

  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(OUT, "plain.txt"), plain);
  ev("done");
}

main()
  .catch((e) => ev("error", { message: String(e && e.stack ? e.stack : e) }))
  .finally(async () => {
    try {
      proc.kill();
    } catch {}
    await sleep(1500);
    try {
      process.kill(proc.pid, 0);
      try { process.kill(proc.pid, "SIGKILL"); } catch {}
    } catch {}
    ev("killed", { pid: proc.pid });
    process.exit(0);
  });
