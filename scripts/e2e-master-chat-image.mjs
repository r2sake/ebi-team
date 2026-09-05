// PR-M4 受け入れ e2e: チャットの**画像添付が実際に turn へ届く**ことを実 claude で 1 回だけ確認する。
//
//   (1) POST /control/chat-attach（生バイト列 + Content-Type: image/png）で画像を保存
//   (2) GET  /control/chat-attachment?name=... で同じバイト列が読み戻せる（サムネイル経路）
//   (3) WS `chatSend` に attachments を付けて送る → master の返答が **画像の内容**に言及する
//
// (3) は「ツールを使うな」と役割プロンプトで縛ったうえで色を答えさせる。
// ツール（Read）でファイルを開く逃げ道を塞いでいるので、色を当てられた＝
// stream-json の image content block が実際に読まれた、という判定になる。
// 併せて toolCall イベントが 0 件であることも確認する。
//
// 実行（サブスク枠を実際に消費する。既定では走らせない）:
//   node scripts/e2e-master-chat-image.mjs
//
// 安全条件（e2e-master-chat.mjs と同じ）:
//  - 稼働 control API（127.0.0.1:8787）には触らない。**専用ポート 8797** で自前のサーバを立てる
//  - `.ebi-team/` は読むだけ。生成物（添付の保存先も含む）はすべて mkdtemp 配下
//  - 停止は必ず PID 指定。広域 pkill はしない
//  - モデルは haiku。実 claude のターンは 1 回だけ

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PORT = Number(process.env.EBI_E2E_CHAT_IMAGE_PORT ?? 8797);
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = process.env.EBI_E2E_CHAT_MODEL ?? "haiku";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const results = [];
const ok = (m) => { results.push(true); console.log("  OK:", m); };
const fail = (m) => { results.push(false); console.error("  NG:", m); };

// ---- 単色 PNG を作る（外部依存なし）----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** size × size の単色 PNG（RGB8）。 */
function solidPng(size, [r, g, b]) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const off = y * (size * 3 + 1);
    raw[off] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function writeMasterMcp(dir) {
  const p = join(dir, "master-control.e2e.mcp.json");
  writeFileSync(
    p,
    `${JSON.stringify(
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
    )}\n`,
  );
  return p;
}

function writeConfig(dir) {
  const p = join(dir, "config.e2e.json");
  writeFileSync(
    p,
    `${JSON.stringify(
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
              "あなたは画像判定係。添付された画像を見て、その画像全体の色を日本語1語（例: 赤・青・緑・黄）だけで答える。" +
              "**ツールは絶対に使わない**（ファイルを開くこともしない）。色以外は何も書かない。",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return p;
}

function startServer(tmpDir, configPath, masterMcp) {
  const proc = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      EBI_PORT: String(PORT),
      EBI_HOST: "127.0.0.1",
      EBI_CONFIG_PATH: configPath,
      EBI_MASTER_MCP_CONFIG: masterMcp,
      EBI_DUMP_PATH: join(tmpDir, "registry.json"),
      EBI_DELIVERY_LOG_PATH: join(tmpDir, "delivery.log"),
      EBI_FIXED_EBI_LOG_PATH: join(tmpDir, "fixed-ebi.log"),
      EBI_USAGE_HISTORY_PATH: join(tmpDir, "usage-history.jsonl"),
      EBI_MASTER_CHAT_LOG_PATH: join(tmpDir, "master-chat.jsonl"),
      EBI_VIEWERS_PATH: join(tmpDir, "viewers.json"),
      // 添付の保存先も使い捨てディレクトリへ（リポジトリの .ebi-team を汚さない）。
      EBI_CHAT_ATTACH_DIR: join(tmpDir, "chat-attachments"),
      EBI_IDLE_NOTIFY: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  return proc;
}

async function openWs() {
  const ws = await new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    w.on("open", () => res(w));
    w.on("error", rej);
  });
  const state = { events: [], states: [] };
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "chatEvent") state.events.push(msg.event);
    else if (msg.type === "chatState") state.states.push(msg.state);
  });
  return { ws, state };
}

async function waitEvent(state, from, pred, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    for (let i = from; i < state.events.length; i++) {
      if (pred(state.events[i])) return { hit: state.events[i], index: i };
    }
    if (Date.now() >= until) return null;
    await sleep(200);
  }
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "ebi-m4-e2e-"));
  log(`tmpDir: ${tmpDir} / port ${PORT} / model ${MODEL}`);
  const masterMcp = writeMasterMcp(tmpDir);
  const configPath = writeConfig(tmpDir);
  const srv = startServer(tmpDir, configPath, masterMcp);
  let client;

  try {
    await sleep(4000);
    client = await openWs();
    const { state } = client;
    const idle = await (async () => {
      const until = Date.now() + 60_000;
      while (Date.now() < until) {
        if (state.states.includes("idle")) return true;
        await sleep(300);
      }
      return false;
    })();
    if (idle) ok("master（chat）が起動して idle になった");
    else fail("master（chat）が idle にならない");

    // ---- (1) 添付のアップロード ----
    const png = solidPng(256, [220, 20, 20]); // 真っ赤
    const up = await fetch(`${BASE}/control/chat-attach`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: png,
    });
    const saved = await up.json().catch(() => null);
    if (up.status === 200 && saved?.name?.endsWith(".png") && saved.path?.startsWith(tmpDir)) {
      ok(`POST /control/chat-attach で保存できた（${saved.path} / ${saved.bytes} バイト）`);
    } else {
      fail(`chat-attach が失敗: status=${up.status} body=${JSON.stringify(saved)}`);
      throw new Error("添付が保存できないので以降を打ち切る");
    }

    // ---- (2) サムネイル配信 ----
    const dl = await fetch(`${BASE}${saved.url}`);
    const got = Buffer.from(await dl.arrayBuffer());
    if (dl.status === 200 && dl.headers.get("content-type") === "image/png" && got.equals(png)) {
      ok("GET /control/chat-attachment で同じバイト列が読み戻せる（サムネイル経路）");
    } else {
      fail(`chat-attachment の配信が不正: status=${dl.status} bytes=${got.length}`);
    }
    // 保管庫の形式に合わない name は 404（パストラバーサル入口が無い）。
    const bad = await fetch(`${BASE}/control/chat-attachment?name=${encodeURIComponent("../config.e2e.json")}`);
    if (bad.status === 404) ok("保管庫の形式に合わない name は 404");
    else fail(`不正な name が ${bad.status} を返した`);

    // ---- (3) 実 claude に画像を送る（このスクリプトで実ターンを回すのは 1 回だけ）----
    const from = state.events.length;
    client.ws.send(
      JSON.stringify({
        type: "chatSend",
        id: "master",
        text: "この画像の色を日本語1語で答えて。",
        attachments: [saved],
      }),
    );
    const user = await waitEvent(state, from, (e) => e.kind === "user", 10_000);
    if (user?.hit.attachments?.[0]?.path === saved.path) ok("user イベントに添付メタが載る（再接続復元用）");
    else fail(`user イベントに添付が載らない: ${JSON.stringify(user?.hit ?? null)}`);

    const text = await waitEvent(
      state,
      from,
      (e) => e.kind === "text" && !e.partial && /赤|レッド|red/i.test(e.text),
      180_000,
    );
    const end = await waitEvent(state, from, (e) => e.kind === "turnEnd", 180_000);
    const toolCalls = state.events.slice(from).filter((e) => e.kind === "toolCall");
    if (text && end?.hit.ok) {
      ok(`返答が画像の内容（赤）に言及した: 「${text.hit.text.trim().slice(0, 40)}」`);
    } else {
      const texts = state.events.slice(from).filter((e) => e.kind === "text").map((e) => e.text);
      fail(`画像の内容に言及しない（turnEnd.ok=${end?.hit.ok}）: ${JSON.stringify(texts).slice(0, 400)}`);
    }
    if (toolCalls.length === 0) {
      ok("ツールを 1 度も使っていない（＝ファイル読みではなく image ブロックで判定している）");
    } else {
      fail(`ツールを使ってしまった（判定が image ブロック由来と言い切れない）: ${toolCalls.map((t) => t.name).join(",")}`);
    }
  } finally {
    try {
      client?.ws.close();
    } catch {}
    srv.kill("SIGTERM");
    await sleep(2500);
    if (srv.exitCode === null) srv.kill("SIGKILL");
    log(`会話ログ: ${join(tmpDir, "master-chat.jsonl")}（tmpDir は残す: ${tmpDir}）`);
  }

  const okCount = results.filter(Boolean).length;
  console.log(`\n==== master chat image e2e: ${okCount}/${results.length} OK ====`);
  process.exit(okCount === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("例外:", e?.stack ?? e);
  process.exit(1);
});
