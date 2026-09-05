// PR-M11「送信 / 停止の分離」の実測 + スクショ（実 claude を使わない・偽 claude で決定的に）。
//
// 検証すること:
//   A. busy 中に Enter で送っても **中断が飛ばない**（FAKE:INTERRUPT が出ない）
//   B. busy 中の送信が **走行中ターンへ合流する**（FAKE:JOIN が出る・user バブルが 2 本並ぶ）
//   C. ⏹ を押したときだけ中断が飛び、「中断しました」が出る
// 撮るもの: 01-busy-desktop.png / 02-aborted-desktop.png / 03-busy-mobile.png
//
// 実行: node tmp/shots-m11/take-shots.mjs（先に npm run build が要る）
// 稼働中の 8787 には一切触らない（別ポート 8816 で自前起動し、終了時に kill する）。
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "/Users/yoimaro/.npm/_npx/db89d7302a373f10/node_modules/playwright/index.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "tmp/shots-m11");
const PORT = 8816;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), "ebi-shots-m11-"));
const bin = join(dir, "claude");
writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} ${join(OUT, "fake-claude-slow.mjs")} "$@"\n`);
chmodSync(bin, 0o755);
const cfg = join(dir, "ebi-team.config.json");
writeFileSync(
  cfg,
  JSON.stringify({
    fixedEbi: [
      { id: "master", kind: "master", ui: "chat", brain: "claude", cwd: ROOT, model: "opus", permissionMode: "auto" },
    ],
  }),
);
const mcp = join(dir, "master.mcp.json");
writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));

const srv = spawn("node", ["dist/server/server/index.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    EBI_PORT: String(PORT),
    EBI_HOST: "127.0.0.1",
    EBI_MASTER_UI: "chat",
    EBI_CONTROL_URL: `http://127.0.0.1:${PORT}`,
    EBI_CONFIG_PATH: cfg,
    EBI_MASTER_MCP_CONFIG: mcp,
    EBI_MASTER_CHAT_LOG_PATH: join(dir, "chat.jsonl"),
    EBI_CHAT_ATTACH_DIR: join(dir, "chat-attachments"),
    EBI_VIEWER_ROOTS: dir,
    EBI_DUMP_PATH: join(dir, "registry.json"),
    EBI_DELIVERY_LOG_PATH: "off",
    EBI_FIXED_EBI_LOG_PATH: "off",
    EBI_USAGE_HISTORY_PATH: join(dir, "usage.jsonl"),
    EBI_VIEWERS_PATH: join(dir, "viewers.json"),
    EBI_IDLE_NOTIFY: "off",
    FAKE_SLOW_MS: "20000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
// 偽 claude の stderr はサーバが拾って **チャットの notice 行**にする（サーバの stdout/stderr
// には出ない）ので、FAKE:* の判定はチャットログの本文から行う（`chatText()`）。
srv.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
srv.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));
console.log("server pid=", srv.pid, "port=", PORT);

async function finish(code) {
  try {
    srv.kill("SIGTERM");
  } catch {}
  await sleep(800);
  try {
    if (srv.exitCode == null) srv.kill("SIGKILL");
  } catch {}
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
  process.exit(code);
}

const results = [];
function check(name, ok, extra = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` … ${extra}` : ""}`);
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? ` … ${extra}` : ""}`);
  return ok;
}

/** チャットログの全文（偽 claude の FAKE:* は notice 行としてここに出る）。 */
async function chatText(page) {
  return await page.locator(".chat-log").innerText();
}

async function openChat(page) {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await sleep(1200);
  await page.locator("tr.agent-row", { hasText: "master" }).first().click();
  await page.waitForSelector(".chat-head", { state: "visible", timeout: 5000 });
}

try {
  await sleep(3500);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 2 });
  await openChat(page);

  // ---- idle: 停止ボタンは見えているが押せない ----
  check("idle で ⏹ が disabled", await page.locator(".chat-stop").isDisabled());
  check("送信ボタンのラベルは常に「送信」(idle)", (await page.locator(".chat-send").innerText()).trim() === "送信");

  // ---- 1 通目 → busy ----
  await page.locator(".chat-input").fill("長いターンを始めて");
  await page.keyboard.press("Enter");
  await sleep(1500);
  const badge = (await page.locator(".chat-state").innerText()).trim();
  check("1 通目で busy になる", badge === "実行中…", `badge=${badge}`);
  check("busy でも送信ボタンは「送信」のまま", (await page.locator(".chat-send").innerText()).trim() === "送信");
  check("busy では ⏹ が押せる", !(await page.locator(".chat-stop").isDisabled()));
  check("busy でも入力欄は有効", !(await page.locator(".chat-input").isDisabled()));

  // ---- 2 通目（busy 中）: 送信であって中断ではない ----
  await page.locator(".chat-input").fill("実行中だけど追加で伝えたいことがある");
  await page.keyboard.press("Enter");
  await sleep(1800);
  await page.screenshot({ path: join(OUT, "01-busy-desktop.png") });

  const userBubbles = await page.locator(".chat-bubble.user").count();
  check("busy 中の Enter で 2 本目の user バブルが出る", userBubbles === 2, `count=${userBubbles}`);
  const duringBusy = await chatText(page);
  check("busy 中の送信で中断が飛んでいない", !duringBusy.includes("FAKE:INTERRUPT"));
  check("busy 中の送信は走行中ターンへ合流した", duringBusy.includes("FAKE:JOIN"));
  const badge2 = (await page.locator(".chat-state").innerText()).trim();
  check("送信後も busy のまま（ターンが生きている）", badge2 === "実行中…", `badge=${badge2}`);

  // ---- ⏹ を押したときだけ中断 ----
  await page.locator(".chat-stop").click();
  await sleep(2000);
  const body = await chatText(page);
  check("⏹ で中断が飛ぶ", body.includes("FAKE:INTERRUPT"));
  check("中断のシステム行が出る", body.includes("中断"), body.split("\n").slice(-3).join(" / "));
  const badge3 = (await page.locator(".chat-state").innerText()).trim();
  check("中断後は busy を抜ける", badge3 !== "実行中…", `badge=${badge3}`);
  check("中断後は ⏹ が再び disabled", await page.locator(".chat-stop").isDisabled());
  await page.screenshot({ path: join(OUT, "02-aborted-desktop.png") });

  // ---- スマホ幅（375px）の見た目 ----
  const mobile = await browser.newPage({ viewport: { width: 375, height: 780 }, deviceScaleFactor: 2 });
  await mobile.goto(`http://127.0.0.1:${PORT}/`);
  await sleep(1800);
  await mobile.locator("#sidebar-toggle").click();
  await sleep(400);
  await mobile.locator("tr.agent-row", { hasText: "master" }).first().click();
  await sleep(800);
  await mobile.locator(".chat-input").fill("スマホからも送れる");
  await mobile.keyboard.press("Enter");
  await sleep(1500);
  await mobile.screenshot({ path: join(OUT, "03-busy-mobile.png") });
  const overflow = await mobile.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check("375px 幅で横はみ出しなし", overflow <= 0, `overflow=${overflow}px`);

  await browser.close();
  console.log("\n---- 実測まとめ ----\n" + results.join("\n"));
  await finish(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
} catch (err) {
  console.error("失敗:", err?.stack ?? err);
  console.log("\n---- ここまでの実測 ----\n" + results.join("\n"));
  await finish(1);
}
