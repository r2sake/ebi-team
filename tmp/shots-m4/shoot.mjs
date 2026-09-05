// PR-M4（入力系）の実画面スクリーンショット取得スクリプト。
//
// 撮るもの:
//   01-history-recall.png   ↑ で過去の送信文を呼び出している状態
//   02-attach-tray.png      画像をペーストして添付トレイにサムネイルが出た状態
//   03-large-paste.png      8,000 文字超の貼り付け → ファイルに落としてパスを添えた誘導
//   04-attach-sent.png      添付を送信した後（バブル内サムネイル + master の返答）
//
// 安全条件:
//  - 稼働 8787 には触らない。専用ポート 8796 で自前サーバを立てる
//  - config / 生成物（添付の保存先を含む）はすべて mkdtemp 配下。`.ebi-team/` は書かない
//  - 停止は PID 指定。広域 pkill はしない
//  - 実 claude（haiku）のターンは 2 回だけ（履歴用の 1 発話 + 画像添付の 1 発話）
//  - Playwright はシステムの Google Chrome を channel 指定で使う（Chrome 拡張は不使用）
//
// 実行: node tmp/shots-m4/shoot.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// ローカルに playwright を入れていないので npx キャッシュのものを使う（PR-M3 と同じ方針）。
const PW_PATH =
  process.env.EBI_PLAYWRIGHT_PATH ??
  "/Users/yoimaro/.npm/_npx/db89d7302a373f10/node_modules/playwright";
const { chromium } = require(PW_PATH);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const OUT = __dirname;
const PORT = Number(process.env.EBI_SHOT_PORT ?? 8796);
const MODEL = "haiku";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[shots-m4] ${m}`);

// ---- 単色 PNG（外部依存なし）----
const CRC = (() => {
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
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
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
function solidPng(size, [r, g, b]) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const off = y * (size * 3 + 1);
    for (let x = 0; x < size; x++) {
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function writeMasterMcp(dir) {
  const p = join(dir, "master-control.shot.mcp.json");
  writeFileSync(
    p,
    JSON.stringify(
      {
        mcpServers: {
          "ebi-control": {
            command: process.execPath,
            args: ["--import", "tsx", join(ROOT, "src/mcp/control-server.ts")],
            cwd: ROOT,
            env: {
              EBI_CONTROL_URL: `http://127.0.0.1:${PORT}`,
              EBI_MCP_ROLE: "master",
              EBI_NOTIFY_SUBSCRIBE: "off",
            },
          },
        },
      },
      null,
      2,
    ),
  );
  return p;
}

function writeConfig(dir) {
  const p = join(dir, "config.shot.json");
  writeFileSync(
    p,
    JSON.stringify(
      {
        fixedEbi: [
          {
            id: "master",
            kind: "master",
            ui: "chat",
            brain: "claude",
            cwd: ROOT,
            model: MODEL,
            permissionMode: "auto",
            appendSystemPrompt:
              "あなたはスクリーンショット撮影用のアシスタント。返答は日本語 1〜2 文で短く。ツールは使わない。",
          },
        ],
      },
      null,
      2,
    ),
  );
  return p;
}

/** registry の master 行を選び、チャットパネルが操作できる状態になるまで待つ。 */
async function selectMaster(page) {
  await page.waitForSelector("tr.agent-row.kind-master", { timeout: 60_000 });
  await page.click("tr.agent-row.kind-master");
  await page.waitForSelector(".chat:not([hidden])", { timeout: 20_000 });
  await page.waitForSelector(".chat-input:not([disabled])", { timeout: 90_000 });
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "ebi-m4-shots-"));
  log(`tmpDir: ${tmpDir} / port ${PORT}`);
  const mcp = writeMasterMcp(tmpDir);
  const config = writeConfig(tmpDir);
  // 静的配信（dist/client）を使うのでビルド済みサーバを起動する
  //（tsx で src から動かすと CLIENT_DIST が解決できず画面が 404 になる）。
  const srv = spawn("node", ["dist/server/server/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      EBI_PORT: String(PORT),
      EBI_HOST: "127.0.0.1",
      EBI_CONFIG_PATH: config,
      EBI_MASTER_UI: "chat",
      EBI_MASTER_MCP_CONFIG: mcp,
      EBI_DUMP_PATH: join(tmpDir, "registry.json"),
      EBI_DELIVERY_LOG_PATH: join(tmpDir, "delivery.log"),
      EBI_FIXED_EBI_LOG_PATH: join(tmpDir, "fixed-ebi.log"),
      EBI_USAGE_HISTORY_PATH: join(tmpDir, "usage-history.jsonl"),
      EBI_MASTER_CHAT_LOG_PATH: join(tmpDir, "master-chat.jsonl"),
      EBI_VIEWERS_PATH: join(tmpDir, "viewers.json"),
      EBI_CHAT_ATTACH_DIR: join(tmpDir, "chat-attachments"),
      EBI_IDLE_NOTIFY: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  srv.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  srv.stderr.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));

  let browser;
  try {
    await sleep(6000);
    browser = await chromium.launch({ channel: "chrome" });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
    await selectMaster(page);

    // ---- 01: 入力履歴（↑ で呼び出し）----
    // 履歴を作るために 1 発話（実 claude のターン 1 回目）。
    await page.fill(".chat-input", "PR-M4 の入力履歴テストです。短く挨拶して。");
    await page.press(".chat-input", "Enter");
    await page.waitForSelector(".chat-turnend", { timeout: 180_000 });
    await sleep(1500);
    // localStorage に残っていることを見せるため、ページを**再読み込み**してから ↑ を押す。
    await page.reload({ waitUntil: "domcontentloaded" });
    await selectMaster(page);
    await page.click(".chat-input");
    await page.press(".chat-input", "ArrowUp");
    await sleep(400);
    const recalled = await page.inputValue(".chat-input");
    log(`↑ で呼び出した本文: ${JSON.stringify(recalled)}`);
    await page.screenshot({ path: join(OUT, "01-history-recall.png") });

    // ---- 02: 画像のペースト添付（サムネイル）----
    const png = solidPng(160, [40, 120, 220]).toString("base64");
    await page.fill(".chat-input", "この画像の色を日本語1語で答えて。");
    await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], "pasted.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const el = document.querySelector(".chat-input");
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, png);
    await page.waitForSelector(".chat-chip-thumb", { timeout: 20_000 });
    await sleep(500);
    await page.screenshot({ path: join(OUT, "02-attach-tray.png") });

    // ---- 04 用: 添付を送る（実 claude のターン 2 回目）----
    await page.press(".chat-input", "Enter");
    await page.waitForSelector(".chat-bubble.user .chat-attachment-thumb", { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll(".chat-turnend").length >= 2, null, {
      timeout: 180_000,
    });
    await sleep(1500);
    await page.screenshot({ path: join(OUT, "04-attach-sent.png") });

    // ---- 03: 大きな貼り付け（8,000 文字超）----
    const big = "この行はダミーのログ本文です。".repeat(700); // 約 10,500 文字
    await page.evaluate((text) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const el = document.querySelector(".chat-input");
      el.focus();
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, big);
    await page.waitForSelector(".chat-hint:not([hidden])", { timeout: 20_000 });
    await sleep(500);
    await page.screenshot({ path: join(OUT, "03-large-paste.png") });
    log(`貼り付け後の入力欄: ${JSON.stringify(await page.inputValue(".chat-input"))}`);

    // 機械チェック: チャット内にエラー行が出ていないこと。
    const errors = await page.$$eval(".chat-system.level-error", (els) => els.map((e) => e.textContent));
    log(`チャット内エラー行: ${errors.length} 件 ${JSON.stringify(errors)}`);
  } finally {
    await browser?.close().catch(() => {});
    srv.kill("SIGTERM");
    await sleep(2000);
    if (srv.exitCode === null) srv.kill("SIGKILL");
    log(`tmpDir は残す: ${tmpDir}`);
  }
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
