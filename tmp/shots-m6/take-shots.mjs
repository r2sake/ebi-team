// PR-M6 ヘッダ表示のスクショ撮影（実 claude を使わない・偽 claude で決定的に作る）。
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "/Users/yoimaro/.npm/_npx/db89d7302a373f10/node_modules/playwright/index.mjs";
import { WebSocket } from "ws";

const ROOT = "/Users/yoimaro/workspace/GitHub/ebi-team/.worktrees/ebi-ebiteam-master-chat-m6";
const OUT = join(ROOT, "tmp/shots-m6");
const PORT = 8813;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), "ebi-shots-m6-"));
const bin = join(dir, "claude");
writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} ${join(ROOT, "scripts/fake-claude-stream.mjs")} "$@"\n`);
chmodSync(bin, 0o755);
const cfg = join(dir, "ebi-team.config.json");
writeFileSync(cfg, JSON.stringify({ fixedEbi: [{ id: "master", kind: "master", ui: "chat", brain: "claude", cwd: ROOT, model: "opus", permissionMode: "auto" }] }, null, 2));
const mcp = join(dir, "master.mcp.json");
writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));

const srv = spawn("node", ["dist/server/server/index.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    EBI_PORT: String(PORT), EBI_HOST: "127.0.0.1", EBI_MASTER_UI: "chat",
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await sleep(1500);
  // master 行を選ぶ
  // registry の master 行（agent-row）を選んで chat パネルを前面に出す。
  await page.locator("tr.agent-row", { hasText: "master" }).first().click();
  await page.waitForSelector(".chat-head", { state: "visible", timeout: 5000 });
  await sleep(500);

  // 03: 未受信＝すべて「—」
  await page.screenshot({ path: join(OUT, "03-header-dash.png") });
  console.log("stats(dash) =", await page.locator(".chat-stats").innerText());

  // WS で chatSend（UI 入力欄は PR-M4 担当なので触らない）
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => ws.on("open", r));
  const send = async (text) => { ws.send(JSON.stringify({ type: "chatSend", id: "master", text })); await sleep(2500); };

  // 01: 通常（ctx 31% / 5h 19% / 週 4%）
  await send("ctx:31 rate:0.19,0.04");
  await page.screenshot({ path: join(OUT, "01-header-normal.png") });
  console.log("stats(normal) =", await page.locator(".chat-stats").innerText());

  // 02: 70% 超（hard）＋ 枠 88%（critical）
  await send("ctx:72 rate:0.88,0.66");
  await page.screenshot({ path: join(OUT, "02-header-warn.png") });
  console.log("stats(warn) =", await page.locator(".chat-stats").innerText());
  console.log("levels =", await page.locator(".chat-stats").evaluate((el) =>
    [...el.querySelectorAll(".chat-stat")].map((s) => `${s.dataset.metric}:${s.className}:${s.textContent}`).join(" | ")));
  // ヘッダ拡大（ヘッダだけ切り出し）
  await page.locator(".chat-head").screenshot({ path: join(OUT, "02b-header-warn-zoom.png") });
  await page.locator(".chat-head").screenshot({ path: join(OUT, "01b-header-normal-zoom.png") }).catch(() => {});
  ws.close();
  await browser.close();
  await finish(0);
} catch (e) {
  console.error(e);
  await finish(1);
}
