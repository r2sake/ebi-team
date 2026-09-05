// PR-M5 承認 / 質問 UI のスクショ撮影（実 claude を使わない・偽 claude で決定的に作る）。
//
// 撮るもの:
//   01-pending-bar.png    … 未応答のスティッキーバー（入力欄の上）
//   02-permission.png     … 承認ダイアログ（許可 / 拒否ボタン付きのバブル）
//   03-question.png       … 質問の選択肢 UI（ラジオ + その他の自由入力）
//   04-settled.png        … 応答後（許可しました / 回答しました）に畳まれた状態
//
// 実行: node tmp/shots-m5/take-shots.mjs（先に npm run build が要る）
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "/Users/yoimaro/.npm/_npx/db89d7302a373f10/node_modules/playwright/index.mjs";
import { WebSocket } from "ws";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "tmp/shots-m5");
const PORT = 8814;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), "ebi-shots-m5-"));
const bin = join(dir, "claude");
writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} ${join(ROOT, "scripts/fake-claude-stream.mjs")} "$@"\n`);
chmodSync(bin, 0o755);
const cfg = join(dir, "ebi-team.config.json");
writeFileSync(
  cfg,
  JSON.stringify(
    { fixedEbi: [{ id: "master", kind: "master", ui: "chat", brain: "claude", cwd: ROOT, model: "opus", permissionMode: "auto" }] },
    null,
    2,
  ),
);
const mcp = join(dir, "master.mcp.json");
writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));

const srv = spawn("node", ["dist/server/server/index.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    EBI_PORT: String(PORT), EBI_HOST: "127.0.0.1", EBI_MASTER_UI: "chat",
    EBI_CONTROL_URL: `http://127.0.0.1:${PORT}`,
    EBI_CONFIG_PATH: cfg, EBI_MASTER_MCP_CONFIG: mcp,
    EBI_MASTER_CHAT_LOG_PATH: join(dir, "chat.jsonl"),
    EBI_DUMP_PATH: join(dir, "registry.json"),
    EBI_DELIVERY_LOG_PATH: "off", EBI_FIXED_EBI_LOG_PATH: "off",
    EBI_USAGE_HISTORY_PATH: join(dir, "usage.jsonl"), EBI_VIEWERS_PATH: join(dir, "viewers.json"),
    EBI_IDLE_NOTIFY: "off",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
srv.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));
console.log("server pid=", srv.pid);

async function finish(code) {
  try { srv.kill("SIGTERM"); } catch {}
  await sleep(500);
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

try {
  await sleep(3500);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await sleep(1500);
  await page.locator("tr.agent-row", { hasText: "master" }).first().click();
  await page.waitForSelector(".chat-head", { state: "visible", timeout: 5000 });

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => ws.on("open", r));
  const send = (text) => ws.send(JSON.stringify({ type: "chatSend", id: "master", text }));

  // ---- 01 / 02: 承認待ち ----
  send("この一時ファイルを消していい？ perm:Bash:rm -f /tmp/ebi-shot-target.txt");
  await page.waitForSelector(".chat-bubble.pending .chat-pending-btn.allow", { timeout: 20000 });
  await sleep(400);
  await page.screenshot({ path: join(OUT, "01-pending-bar.png") });
  console.log("pending bar =", await page.locator(".chat-pending-bar").innerText());
  await page.locator(".chat-bubble.pending").last().screenshot({ path: join(OUT, "02-permission.png") });

  // 許可して畳む
  await page.locator(".chat-pending-btn.allow").last().click();
  await page.waitForSelector(".chat-bubble.pending.settled-allowed", { timeout: 20000 });
  await sleep(1500);

  // ---- 03: 質問の選択肢 UI ----
  send("ask:今日の昼食はどちらにしますか？|寿司,ラーメン");
  await page.waitForSelector(".chat-question .chat-question-option", { timeout: 20000 });
  await sleep(400);
  await page.locator(".chat-bubble.pending").last().screenshot({ path: join(OUT, "03-question.png") });

  // ---- 04: 回答後（決着表示）----
  await page.locator(".chat-question-option input").last().check();
  await page.locator(".chat-question .chat-pending-btn").last().click();
  await page.waitForSelector(".chat-bubble.pending.settled-allowed >> nth=1", { timeout: 20000 });
  await sleep(1200);
  await page.screenshot({ path: join(OUT, "04-settled.png") });
  console.log(
    "settled =",
    await page.locator(".chat-pending-settled").allInnerTexts(),
  );

  await browser.close();
  console.log("撮影完了:", OUT);
  await finish(0);
} catch (err) {
  console.error("失敗:", err?.stack ?? err);
  await finish(1);
}
