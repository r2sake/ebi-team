// context-guard（master コンテキスト枯渇ガード）の E2E（実課金なし）。
//
// EBI_COMMAND=bash + 別ポートで一時サーバを立て、statusLine JSON の used_percentage を
// 段階投入して以下を確認する:
//
//  C1. 60% では notice が出ない
//  C2. 66%（soft 到達）で id="context-guard" の notice が出る
//      - キリが良い（bash master は idle・dynamic 無し）ので advance と /clear 促しの 2 本
//      - advance の本文に「転記用の定型文」と 数値/上限/走行中エビ数 が入る
//  C3. 68% では追加の notice が出ない（同レベル抑止）
//  C4. 72%（hard 到達）で hard の notice が 1 本出る
//  C5. 通知が master セッションへ inject される（bash master の scrollback に出る）
//
// さらに **chat 経路**（ui:"chat" の master・PR-M6）でも同じ判定が届くことを確かめる。
// 実 claude は起動しない（scripts/fake-claude-stream.mjs を `claude` として PATH の先頭に置く）＝
// サブスク枠も課金も消費しない。turnEnd.usage → UsageStore → contextGuard の一本道を通す:
//
//  D1. ctx 60% では notice が出ない
//  D2. ctx 66% で advance ＋ /clear 促しの 2 本（chat の master は turnEnd で idle になる＝キリが良い）
//  D3. ctx 68% では追加の notice が出ない
//  D4. ctx 72% で hard の notice が 1 本
//  D5. 通知が chat master へ届く（WS の chatEvent inbound に出る）
//  D6. rate_limit_event の枠（5h / 週次）が WS usage に載る（ヘッダ表示の供給源）
//
// 後始末まで行う。dev サーバ(8787/5173)は触らない。

import { spawn } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// dev(8787) や他 e2e(8801-8810) と衝突しないポートを使う。
const PORT = 8811;
const BASE = `http://127.0.0.1:${PORT}`;
/** chat 経路（PR-M6）用のポート。terminal 経路とは別サーバを立てる。 */
const CHAT_PORT = 8812;
const CHAT_BASE = `http://127.0.0.1:${CHAT_PORT}`;

const tmpDir = mkdtempSync(join(tmpdir(), "ebi-e2e-ctxguard-"));
const configPath = join(tmpDir, "ebi-team.config.json");
writeFileSync(
  configPath,
  JSON.stringify(
    {
      fixedEbi: [
        { id: "master", kind: "master", cwd: root, model: "opus", command: "bash", args: ["-c", "exec cat"] },
      ],
    },
    null,
    2,
  ),
);

const results = [];
const ok = (m) => { results.push(true); console.log("  OK:", m); };
const fail = (m) => { results.push(false); console.error("  NG:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postUsage(pct) {
  const res = await fetch(`${BASE}/control/usage`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ebi-Id": "master" },
    body: JSON.stringify({
      model: { id: "claude-fable-5-1", display_name: "Fable 5.1" },
      cost: { total_cost_usd: 1 },
      context_window: {
        context_window_size: 1000000,
        used_percentage: pct,
        current_usage: { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 4, cache_read_input_tokens: 5 },
      },
    }),
  });
  return res.status;
}

let server;
let ws;
/** chat 経路（第 2 フェーズ）で立てるサーバ / WS / 一時ディレクトリ。 */
let chatServer = null;
let chatWs = null;
let chatTmpDir = null;
async function cleanup(code) {
  try { ws?.close(); } catch {}
  try { chatWs?.close(); } catch {}
  // 停止は必ず PID 指定（広域 pkill はしない）。
  try { server?.kill("SIGTERM"); } catch {}
  try { chatServer?.kill("SIGTERM"); } catch {}
  await sleep(500);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (chatTmpDir) { try { rmSync(chatTmpDir, { recursive: true, force: true }); } catch {} }
  process.exit(code);
}

server = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    EBI_PORT: String(PORT),
    EBI_COMMAND: "bash",
    EBI_CONFIG_PATH: configPath,
    EBI_DUMP_PATH: join(tmpDir, "registry.json"),
    EBI_DELIVERY_LOG_PATH: "off",
    EBI_FIXED_EBI_LOG_PATH: "off",
    // 生成物はすべて mkdtemp 配下に閉じる（.ebi-team/ を汚さない）。
    EBI_USAGE_HISTORY_PATH: join(tmpDir, "usage-history.jsonl"),
    EBI_VIEWERS_PATH: join(tmpDir, "viewers.json"),
    EBI_IDLE_MS: "300",
    EBI_MIN_BOOT_MS: "300",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
server.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));

const overall = setTimeout(() => { fail("全体タイムアウト"); void finish(); }, 90000);

async function finish() {
  clearTimeout(overall);
  const okCount = results.filter(Boolean).length;
  console.log(`\n==== context-guard E2E 結果: ${okCount}/${results.length} OK ====`);
  await cleanup(okCount === results.length ? 0 : 1);
}

/** 受信した context-guard notice（replay は除く）。 */
const notices = [];
function connectWs() {
  return new Promise((resolveWs) => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on("open", () => resolveWs());
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "notice" && msg.id === "context-guard" && !msg.replay) notices.push(msg.text);
    });
    ws.on("error", () => {});
  });
}

async function scrollbackOfMaster() {
  const res = await fetch(`${BASE}/control/scrollback?id=master`);
  const body = await res.json().catch(() => null);
  return body?.data ?? JSON.stringify(body ?? {});
}

async function main() {
  await sleep(3000); // サーバ起動＋固定エビ spawn 待ち
  await connectWs();
  await sleep(1200); // master が idle に落ちるのを待つ（キリが良い状態を作る）

  console.log("\n--- C1. 60%: 発火しない ---");
  await postUsage(60);
  await sleep(400);
  if (notices.length === 0) ok("60% では notice なし");
  else fail("60% で発火した: " + JSON.stringify(notices));

  console.log("\n--- C2. 66%: advance ＋ /clear 促し ---");
  await postUsage(66);
  await sleep(600);
  if (notices.length === 2) ok(`66% で notice 2 本（advance ＋ /clear 促し）`);
  else fail(`66% の notice 本数が想定外: ${notices.length} / ${JSON.stringify(notices)}`);

  const advance = notices[0] ?? "";
  if (/--- ここから ---/.test(advance) && /--- ここまで ---/.test(advance)) ok("advance に転記用の定型文が入る");
  else fail("advance に転記ブロックが無い: " + advance);
  if (/66%/.test(advance) && /1,000,000 tokens/.test(advance) && /走行中のエビは 0 匹/.test(advance)) {
    ok("advance に 数値/上限/走行中エビ数 が埋まる");
  } else {
    fail("advance の埋め込みが不足: " + advance);
  }
  if (/\/clear/.test(notices[1] ?? "")) ok("2 本目が /clear 促し");
  else fail("2 本目が /clear 促しでない: " + (notices[1] ?? ""));

  console.log("\n--- C3. 68%: 同レベルでは追加発火しない ---");
  await postUsage(68);
  await sleep(400);
  if (notices.length === 2) ok("68% では追加 notice なし");
  else fail("68% で追加発火した: " + notices.length);

  console.log("\n--- C4. 72%: hard 通知 ---");
  await postUsage(72);
  await sleep(600);
  if (notices.length === 3 && /70% を超えました/.test(notices[2] ?? "")) ok("72% で hard 通知 1 本");
  else fail(`72% の結果が想定外: ${notices.length} / ${JSON.stringify(notices.slice(2))}`);

  console.log("\n--- C5. master セッションへの inject ---");
  const sb = await scrollbackOfMaster();
  if (/context-guard/.test(sb)) ok("master の scrollback に context-guard の通知が届いている");
  else fail("master へ inject されていない（scrollback 抜粋）: " + sb.slice(-400));

  // ---- 第 2 フェーズ: chat 経路（ui:"chat" の master・PR-M6）----
  try { ws?.close(); } catch {}
  try { server?.kill("SIGTERM"); } catch {}
  server = null;
  await sleep(500);
  await chatPhase();

  await finish();
}

// ===== 第 2 フェーズ: chat 経路（ui:"chat" の master・PR-M6）=====
//
// 偽 claude（scripts/fake-claude-stream.mjs）を `claude` という名前で PATH の先頭に置き、
// chatSend の本文で文脈% を指示して turnEnd.usage を作る。実 claude は起動しない。

/** PATH の先頭に置く偽 claude を作る（実行属性つき）。 */
function writeFakeClaude(dir) {
  const p = join(dir, "claude");
  writeFileSync(p, `#!/bin/sh\nexec ${process.execPath} ${join(root, "scripts/fake-claude-stream.mjs")} "$@"\n`);
  chmodSync(p, 0o755);
  return dir;
}

/** chat モードの master 1 体だけの使い捨て config。 */
function writeChatConfig(dir) {
  const p = join(dir, "ebi-team.config.json");
  writeFileSync(
    p,
    JSON.stringify(
      {
        fixedEbi: [
          { id: "master", kind: "master", ui: "chat", brain: "claude", cwd: root, model: "opus", permissionMode: "auto" },
        ],
      },
      null,
      2,
    ),
  );
  return p;
}

/** chat 用サーバの WS。context-guard notice / inbound / usage を溜める。 */
function connectChatWs(state) {
  return new Promise((resolveWs) => {
    chatWs = new WebSocket(`ws://127.0.0.1:${CHAT_PORT}/ws`);
    chatWs.on("open", () => resolveWs());
    chatWs.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "notice" && msg.id === "context-guard" && !msg.replay) state.notices.push(msg.text);
      if (msg.type === "chatEvent") state.events.push(msg.event);
      if (msg.type === "usage") state.usage = msg;
    });
    chatWs.on("error", () => {});
  });
}

/** chatSend を 1 本投げて turnEnd が返るまで待つ。 */
async function chatTurn(state, text, timeoutMs = 8000) {
  const before = state.events.filter((e) => e.kind === "turnEnd").length;
  chatWs.send(JSON.stringify({ type: "chatSend", id: "master", text }));
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (state.events.filter((e) => e.kind === "turnEnd").length > before) return true;
    await sleep(50);
  }
  return false;
}

async function chatPhase() {
  console.log("\n===== 第 2 フェーズ: chat 経路（ui:\"chat\"・偽 claude）=====");
  chatTmpDir = mkdtempSync(join(tmpdir(), "ebi-e2e-ctxguard-chat-"));
  const binDir = writeFakeClaude(chatTmpDir);
  const chatConfig = writeChatConfig(chatTmpDir);
  // --mcp-config に渡すダミー（偽 claude は読まない）。実 .ebi-team/ には触らない。
  const mcpPath = join(chatTmpDir, "master-control.mcp.json");
  writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2));

  chatServer = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      EBI_PORT: String(CHAT_PORT),
      EBI_HOST: "127.0.0.1",
      EBI_MASTER_UI: "chat",
      EBI_CONFIG_PATH: chatConfig,
      EBI_MASTER_MCP_CONFIG: mcpPath,
      EBI_MASTER_CHAT_LOG_PATH: join(chatTmpDir, "master-chat.jsonl"),
      EBI_DUMP_PATH: join(chatTmpDir, "registry.json"),
      EBI_DELIVERY_LOG_PATH: "off",
      EBI_FIXED_EBI_LOG_PATH: "off",
      EBI_USAGE_HISTORY_PATH: join(chatTmpDir, "usage-history.jsonl"),
      EBI_VIEWERS_PATH: join(chatTmpDir, "viewers.json"),
      EBI_IDLE_NOTIFY: "off",
      EBI_IDLE_MS: "300",
      EBI_MIN_BOOT_MS: "300",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  chatServer.stdout.on("data", (d) => process.stdout.write("[chat-srv] " + d));
  chatServer.stderr.on("data", (d) => process.stderr.write("[chat-srv-err] " + d));

  const state = { notices: [], events: [], usage: null };
  await sleep(3000); // サーバ起動 + 偽 claude spawn 待ち
  await connectChatWs(state);
  await sleep(500);

  console.log("\n--- D1. chat: ctx 60% では発火しない ---");
  if (await chatTurn(state, "ctx:60 rate:0.19,0.04")) ok("chat: turnEnd が返る（偽 claude の 1 ターン）");
  else fail("chat: turnEnd が返らない");
  await sleep(400);
  if (state.notices.length === 0) ok("chat: 60% では notice なし");
  else fail("chat: 60% で発火した: " + JSON.stringify(state.notices));

  console.log("\n--- D2. chat: ctx 66% で advance ＋ /clear 促し ---");
  await chatTurn(state, "ctx:66");
  await sleep(800);
  if (state.notices.length === 2) ok("chat: 66% で notice 2 本（advance ＋ /clear 促し）");
  else fail(`chat: 66% の notice 本数が想定外: ${state.notices.length} / ${JSON.stringify(state.notices)}`);
  if (/1,000,000 tokens/.test(state.notices[0] ?? "")) ok("chat: 文脈窓（result.modelUsage）が通知に載る");
  else fail("chat: advance に上限が載っていない: " + (state.notices[0] ?? ""));
  if (/\/clear/.test(state.notices[1] ?? "")) ok("chat: 2 本目が /clear 促し（master が idle ＝キリが良い）");
  else fail("chat: 2 本目が /clear 促しでない: " + (state.notices[1] ?? ""));

  console.log("\n--- D3. chat: ctx 68% では追加発火しない ---");
  await chatTurn(state, "ctx:68");
  await sleep(600);
  if (state.notices.length === 2) ok("chat: 68% では追加 notice なし");
  else fail("chat: 68% で追加発火した: " + state.notices.length);

  console.log("\n--- D4. chat: ctx 72% で hard 通知 ---");
  await chatTurn(state, "ctx:72");
  await sleep(800);
  if (state.notices.length === 3 && /70% を超えました/.test(state.notices[2] ?? "")) ok("chat: 72% で hard 通知 1 本");
  else fail(`chat: 72% の結果が想定外: ${state.notices.length} / ${JSON.stringify(state.notices.slice(2))}`);

  console.log("\n--- D5. chat: 通知が master の会話へ届く（inbound）---");
  await sleep(600);
  const inbound = state.events.filter((e) => e.kind === "inbound" && /context-guard/.test(e.text ?? ""));
  if (inbound.length > 0) ok(`chat: inbound で master へ届いている（${inbound.length} 件）`);
  else fail("chat: inbound が来ていない: " + JSON.stringify(state.events.map((e) => e.kind)));

  console.log("\n--- D6. chat: rate_limit_event の枠が WS usage に載る ---");
  const rl = state.usage?.rateLimits ?? null;
  if (rl?.fiveHour?.usedPct === 19 && rl?.sevenDay?.usedPct === 4) {
    ok("chat: 5h 19% / 週次 4%（utilization 0.19/0.04 の ×100）が usage に載る");
  } else {
    fail("chat: 枠が想定外: " + JSON.stringify(rl));
  }
  const master = (state.usage?.agents ?? []).find((a) => a.id === "master");
  if (master && master.contextUsedPct === 72 && master.contextSize === 1_000_000) {
    ok("chat: usage の master エントリに文脈% と文脈窓が載る（ヘッダ表示の供給源）");
  } else {
    fail("chat: usage の master エントリが想定外: " + JSON.stringify(master ?? null));
  }
}

main().catch(async (err) => {
  console.error("E2E 実行エラー:", err);
  fail("例外");
  await finish();
});
