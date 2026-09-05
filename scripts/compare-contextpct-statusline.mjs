// contextPct（chat モードの算出値）と statusLine の context% を同一セッションで並べて誤差を測る。
//
// 背景（PR-M6）: chat モードの master には statusLine が無いため、文脈使用率は
// `turnEnd` の usage（ターン最後の assistant の message.usage ÷ result.modelUsage[model].contextWindow）
// から自前で算出している（src/server/master/claudeEvents.ts）。この値が PTY 時代の
// statusLine `context_window.used_percentage` とどれだけズレるかを実測する。
//
// **実測でわかったこと**: `claude -p`（ヘッドレス）では statusLine コマンドは呼ばれない
//（settings.json に statusLine を仕込んでも stdin が来ない＝0 バイト）。そこで
//   ① ヘッドレスで 1 ターン回して contextPct を算出 → ② 同じ session を `--resume` で
//   対話起動し（PTY）、statusLine が吐く JSON を捕まえる
// を数ターン繰り返して並べる。
//
// 実行（**実 claude を起動する＝サブスク枠を消費する**。既定では走らせない）:
//   node --import tsx scripts/compare-contextpct-statusline.mjs
//   EBI_CMP_TURNS=3 EBI_CMP_MODEL=haiku node --import tsx scripts/compare-contextpct-statusline.mjs
//
// 安全条件: 稼働 8787 / .ebi-team/ には触らない（生成物は mkdtemp 配下）。
// 停止は PID 指定（広域 pkill はしない）。モデルは既定 haiku。

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import pty from "node-pty";
import { ClaudeStreamNormalizer } from "../src/server/master/claudeEvents.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TURNS = Number(process.env.EBI_CMP_TURNS ?? 3);
const MODEL = process.env.EBI_CMP_MODEL ?? "haiku";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), "ebi-ctxpct-cmp-"));
const capture = join(dir, "statusline.jsonl");
const slScript = join(dir, "statusline.sh");
writeFileSync(slScript, `#!/bin/sh\ncat >> ${capture}\nprintf '\\n' >> ${capture}\necho ebi\n`);
chmodSync(slScript, 0o755);
const settings = join(dir, "settings.json");
writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: slScript } }, null, 2));

/** ヘッドレス claude を 1 本立てて、送った本文ごとに turnEnd の usage を返す。 */
function startHeadless(resumeSessionId) {
  const args = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--replay-user-messages", "--model", MODEL,
  ];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  const proc = spawn("claude", args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  const normalizer = new ClaudeStreamNormalizer();
  const waiters = [];
  createInterface({ input: proc.stdout }).on("line", (line) => {
    let raw;
    try { raw = JSON.parse(line); } catch { return; }
    for (const ev of normalizer.push(raw)) {
      if (ev.kind === "turnEnd") {
        const w = waiters.shift();
        if (w) w(ev);
      }
    }
  });
  proc.stderr.on("data", () => {});
  return {
    proc,
    normalizer,
    send(text) {
      const line = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
      const done = new Promise((r) => waiters.push(r));
      proc.stdin.write(`${line}\n`);
      return done;
    },
  };
}

/** 同じ session を対話起動して statusLine JSON を 1 個捕まえる（起動 → 数秒 → 終了）。 */
async function captureStatusLine(sessionId) {
  const before = existsSync(capture) ? readFileSync(capture, "utf8") : "";
  const term = pty.spawn("claude", ["--resume", sessionId, "--model", MODEL, "--settings", settings], {
    name: "xterm-256color", cols: 120, rows: 40, cwd: ROOT, env: process.env,
  });
  let out = "";
  term.onData((d) => { out += d; });
  const until = Date.now() + 30_000;
  let json = null;
  while (Date.now() < until) {
    await sleep(500);
    const now = existsSync(capture) ? readFileSync(capture, "utf8") : "";
    if (now.length > before.length) {
      const lines = now.slice(before.length).split("\n").filter((l) => l.trim().startsWith("{"));
      const last = lines[lines.length - 1];
      if (last) { try { json = JSON.parse(last); } catch {} }
      if (json) break;
    }
  }
  try { term.kill(); } catch {}
  await sleep(300);
  if (!json) console.error("  statusLine を捕まえられませんでした（TUI 出力の末尾）:", out.slice(-300));
  return json;
}

const rows = [];
async function main() {
  let sessionId = null;
  let head = startHeadless(null);
  for (let i = 1; i <= TURNS; i += 1) {
    const turn = await head.send(
      `これはツール不要の計測用ターンです（${i} 回目）。「了解」とだけ 1 行で返してください。`,
    );
    sessionId = head.normalizer.sessionId;
    const mine = turn.usage?.contextUsedPct ?? null;
    console.log(`\n[turn ${i}] session=${sessionId} contextPct(算出)=${mine}% / 窓=${turn.usage?.contextSize}`);
    // 対話側は同じセッションを掴めないので、いったんヘッドレスを終了してから resume する。
    head.proc.stdin.end();
    head.proc.kill("SIGINT");
    await sleep(1000);
    const sl = await captureStatusLine(sessionId);
    const slPct = sl?.context_window?.used_percentage ?? null;
    const slSize = sl?.context_window?.context_window_size ?? null;
    console.log(`[turn ${i}] statusLine used_percentage=${slPct}% / 窓=${slSize}`);
    rows.push({ turn: i, mine, slPct, slSize, diff: mine != null && slPct != null ? Number((mine - slPct).toFixed(2)) : null });
    if (i < TURNS) {
      head = startHeadless(sessionId);
      await sleep(500);
    } else {
      try { head.proc.kill("SIGKILL"); } catch {}
    }
  }

  console.log("\n==== contextPct 併走比較 ====");
  console.log("turn | 算出 contextPct | statusLine | 差(pt) | 窓(statusLine)");
  for (const r of rows) {
    console.log(`${r.turn} | ${r.mine}% | ${r.slPct}% | ${r.diff} | ${r.slSize}`);
  }
  const diffs = rows.map((r) => r.diff).filter((d) => d != null).map(Math.abs);
  if (diffs.length > 0) {
    console.log(`最大誤差: ${Math.max(...diffs)} pt / 平均: ${(diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(2)} pt`);
  }
  writeFileSync(join(ROOT, "tmp/contextpct-statusline-compare.json"), `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`結果: tmp/contextpct-statusline-compare.json / 一時ディレクトリ: ${dir}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => { await sleep(200); try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(process.exitCode ?? 0); });
