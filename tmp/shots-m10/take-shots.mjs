// PR-M10 チャット内画像共有 / ライトボックスのスクショ撮影
// （実 claude を使わない・偽 claude + 制御API で決定的に作る）。
//
// 撮るもの:
//   01-card-desktop.png     … チャット内の画像カード（見出し + サムネイル + 説明文）
//   02-lightbox-desktop.png … クリックで開いたライトボックス（枚数インジケータ・左右送り）
//   03-lightbox-next.png    … → で次の画像（ボス添付も同じ列に載る）
//   04-card-mobile.png      … 375px 幅の画像カード（横はみ出しなし）
//   05-lightbox-mobile.png  … 375px 幅のライトボックス
//
// 実行: node tmp/shots-m10/take-shots.mjs（先に npm run build が要る）
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "/Users/yoimaro/.npm/_npx/db89d7302a373f10/node_modules/playwright/index.mjs";
import { WebSocket } from "ws";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "tmp/shots-m10");
const PORT = 8815;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// ---- 単色 PNG（外部依存なし）----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** w × h の 2 色ストライプ PNG（拡大したときに縦横比が分かる絵にする）。 */
function stripePng(w, h, a, b) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1);
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      const c = Math.floor(x / 32) % 2 === 0 ? a : b;
      raw[off + 1 + x * 3] = c[0];
      raw[off + 2 + x * 3] = c[1];
      raw[off + 3 + x * 3] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const dir = mkdtempSync(join(tmpdir(), "ebi-shots-m10-"));
const work = join(dir, "workspace");
mkdirSync(work, { recursive: true });
const wide = join(work, "ebi-wide.png");
const tall = join(work, "ebi-tall.png");
writeFileSync(wide, stripePng(640, 360, [255, 138, 91], [40, 40, 48]));
writeFileSync(tall, stripePng(360, 640, [90, 170, 255], [40, 40, 48]));

const bin = join(dir, "claude");
writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} ${join(ROOT, "scripts/fake-claude-stream.mjs")} "$@"\n`);
chmodSync(bin, 0o755);
const cfg = join(dir, "ebi-team.config.json");
writeFileSync(
  cfg,
  JSON.stringify(
    {
      fixedEbi: [
        { id: "master", kind: "master", ui: "chat", brain: "claude", cwd: ROOT, model: "opus", permissionMode: "auto" },
      ],
    },
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
    EBI_PORT: String(PORT),
    EBI_HOST: "127.0.0.1",
    EBI_MASTER_UI: "chat",
    EBI_CONTROL_URL: `http://127.0.0.1:${PORT}`,
    EBI_CONFIG_PATH: cfg,
    EBI_MASTER_MCP_CONFIG: mcp,
    EBI_MASTER_CHAT_LOG_PATH: join(dir, "chat.jsonl"),
    EBI_CHAT_ATTACH_DIR: join(dir, "chat-attachments"),
    EBI_VIEWER_ROOTS: work,
    EBI_DUMP_PATH: join(dir, "registry.json"),
    EBI_DELIVERY_LOG_PATH: "off",
    EBI_FIXED_EBI_LOG_PATH: "off",
    EBI_USAGE_HISTORY_PATH: join(dir, "usage.jsonl"),
    EBI_VIEWERS_PATH: join(dir, "viewers.json"),
    EBI_IDLE_NOTIFY: "off",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
srv.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));
console.log("server pid=", srv.pid);

async function finish(code) {
  try {
    srv.kill("SIGTERM");
  } catch {}
  await sleep(500);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
  process.exit(code);
}

/** master が chat_image を呼ぶのと同じ制御API を直接叩く。 */
async function share(path, title, caption) {
  const res = await fetch(`http://127.0.0.1:${PORT}/control/chat-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, title, caption }),
  });
  console.log("share:", res.status, (await res.json())?.name ?? "");
}

try {
  await sleep(3500);
  const browser = await chromium.launch();

  // ===== デスクトップ =====
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await sleep(1500);
  await page.locator("tr.agent-row", { hasText: "master" }).first().click();
  await page.waitForSelector(".chat-head", { state: "visible", timeout: 5000 });

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "chatSend", id: "master", text: "エビの画像を 2 枚見せて" }));
  await sleep(1200);
  await share(wide, "エビ（16:9）", "imagegen エビの成果。chat_image で共有した 1 枚目");
  await sleep(600);
  await share(tall, "エビ（縦長）", "縦横比が違っても contain で収まる");
  await sleep(1200);

  await page.waitForSelector(".chat-image-thumb", { timeout: 10000 });
  await page.screenshot({ path: join(OUT, "01-card-desktop.png") });

  // ---- ライトボックス ----
  await page.locator(".chat-image-thumb").first().click();
  await page.waitForSelector(".chat-lightbox:not([hidden])", { timeout: 5000 });
  await sleep(600);
  await page.screenshot({ path: join(OUT, "02-lightbox-desktop.png") });
  console.log("counter =", await page.locator(".chat-lightbox-counter").innerText());

  await page.keyboard.press("ArrowRight");
  await sleep(500);
  await page.screenshot({ path: join(OUT, "03-lightbox-next.png") });
  console.log("counter(next) =", await page.locator(".chat-lightbox-counter").innerText());
  await page.keyboard.press("Escape");
  await sleep(400);
  console.log("closed =", await page.locator(".chat-lightbox").isHidden());

  // ===== スマホ幅（375px）=====
  const mobile = await browser.newPage({ viewport: { width: 375, height: 780 }, deviceScaleFactor: 2 });
  await mobile.goto(`http://127.0.0.1:${PORT}/`);
  await sleep(2000);
  // 狭幅では registry がドロワーなので、☰ で開いてから master 行を選ぶ。
  await mobile.locator("#sidebar-toggle").click();
  await sleep(400);
  await mobile.locator("tr.agent-row", { hasText: "master" }).first().click();
  await sleep(600);
  await mobile.waitForSelector(".chat-image-thumb", { timeout: 10000 });
  await sleep(800);
  await mobile.screenshot({ path: join(OUT, "04-card-mobile.png") });
  // 横スクロールが出ていないこと（はみ出しの機械チェック）。
  const overflow = await mobile.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log("mobile 横はみ出し(px) =", overflow);
  await mobile.locator(".chat-image-thumb").first().click();
  await mobile.waitForSelector(".chat-lightbox:not([hidden])", { timeout: 5000 });
  await sleep(600);
  await mobile.screenshot({ path: join(OUT, "05-lightbox-mobile.png") });

  await browser.close();
  console.log("撮影完了:", OUT);
  await finish(0);
} catch (err) {
  console.error("失敗:", err?.stack ?? err);
  await finish(1);
}
