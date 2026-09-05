// PR-M11「返信（引用）」の実測 + スクショ（実 claude を使わない・偽 claude で決定的に）。
//
// 検証すること:
//   A. master の発言の ↩︎ で入力欄の上に引用プレビューが出る（✕ で解除できる）
//   B. 送るとボスのバブルに引用チップが残り、押すと引用元がフラッシュする
//   C. **master の CLI に届く本文**の先頭に `> [reply to master#<seq>] <抜粋>` が付く
//      （偽 claude が受信本文を `RECV| …` で復唱するので画面から確認できる）
//   D. 自分の発話・ツール行には ↩︎ が出ない
// 撮るもの: 01-reply-preview.png / 02-reply-sent.png / 03-reply-mobile.png
//
// 実行: node tmp/shots-m11-reply/take-shots.mjs（先に npm run build が要る）
// 稼働中の 8787 には一切触らない（別ポート 8817 で自前起動し、終了時に kill する）。
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "/Users/yoimaro/.npm/_npx/db89d7302a373f10/node_modules/playwright/index.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "tmp/shots-m11-reply");
const PORT = 8817;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), "ebi-shots-m11r-"));
const bin = join(dir, "claude");
writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} ${join(OUT, "fake-claude-echo.mjs")} "$@"\n`);
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

  // ---- master の発言を 1 つ作る ----
  await page.locator(".chat-input").fill("PR-A から着手します");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".chat-bubble.assistant", { timeout: 10000 });
  await sleep(800);

  // ---- ↩︎ の有無（master の発言にだけ出る）----
  check(
    "master の発言に ↩︎ が出る",
    (await page.locator(".chat-bubble.assistant .chat-reply-btn").count()) === 1,
  );
  check(
    "ボスの発話に ↩︎ は出ない",
    (await page.locator(".chat-bubble.user .chat-reply-btn").count()) === 0,
  );

  // ---- 返信を選ぶ → 引用プレビュー ----
  await page.locator(".chat-bubble.assistant .chat-reply-btn").first().click();
  await sleep(400);
  const preview = (await page.locator(".chat-reply-jump").innerText()).trim();
  check("引用プレビューが出る", /^↩︎ master#\d+ に返信: /.test(preview), preview);
  await page.screenshot({ path: join(OUT, "01-reply-preview.png") });

  // ---- ✕ で解除できる ----
  await page.locator(".chat-reply-clear").click();
  await sleep(300);
  check("✕ で引用プレビューが消える", await page.locator(".chat-reply").isHidden());

  // ---- もう一度選んで送信 ----
  await page.locator(".chat-bubble.assistant .chat-reply-btn").first().click();
  await sleep(300);
  const seq = Number(/master#(\d+)/.exec(await page.locator(".chat-reply-jump").innerText())?.[1]);
  await page.locator(".chat-input").fill("その方針で進めて");
  await page.keyboard.press("Enter");
  await sleep(1500);

  check("送信後は引用プレビューが消える", await page.locator(".chat-reply").isHidden());
  const chip = (await page.locator(".chat-quote").innerText()).trim();
  check("ボスのバブルに引用チップが残る", chip.startsWith(`↩︎ master#${seq}: `), chip);

  // ---- CLI に届いた本文（偽 claude の復唱）----
  const log = await page.locator(".chat-log").innerText();
  check(
    "CLI へ届く本文の先頭に引用ヘッダが付く",
    log.includes(`RECV| > [reply to master#${seq}] `),
    (log.split("\n").find((l) => l.startsWith("RECV| >")) ?? "(復唱が見つからない)").slice(0, 90),
  );
  check("CLI へ届く本文の 2 行目が本文", log.includes("RECV| その方針で進めて"));
  await page.screenshot({ path: join(OUT, "02-reply-sent.png") });

  // ---- 引用チップで引用元へジャンプ（flash が付く）----
  await page.locator(".chat-quote").first().click();
  await sleep(200);
  check("引用チップで引用元がフラッシュする", (await page.locator(".flash").count()) > 0);

  // ---- スマホ幅 ----
  const mobile = await browser.newPage({ viewport: { width: 375, height: 780 }, deviceScaleFactor: 2 });
  await mobile.goto(`http://127.0.0.1:${PORT}/`);
  await sleep(1800);
  await mobile.locator("#sidebar-toggle").click();
  await sleep(400);
  await mobile.locator("tr.agent-row", { hasText: "master" }).first().click();
  await sleep(800);
  await mobile.locator(".chat-bubble.assistant .chat-reply-btn").first().click();
  await sleep(400);
  check("375px でも引用プレビューが出る", await mobile.locator(".chat-reply").isVisible());
  await mobile.screenshot({ path: join(OUT, "03-reply-mobile.png") });
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
