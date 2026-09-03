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
// 後始末まで行う。dev サーバ(8787/5173)は触らない。

import { spawn } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// dev(8787) や他 e2e(8801-8810) と衝突しないポートを使う。
const PORT = 8811;
const BASE = `http://127.0.0.1:${PORT}`;

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
async function cleanup(code) {
  try { ws?.close(); } catch {}
  try { server?.kill("SIGTERM"); } catch {}
  await sleep(500);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
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
    EBI_IDLE_MS: "300",
    EBI_MIN_BOOT_MS: "300",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
server.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));

const overall = setTimeout(() => { fail("全体タイムアウト"); void finish(); }, 40000);

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

  await finish();
}

main().catch(async (err) => {
  console.error("E2E 実行エラー:", err);
  fail("例外");
  await finish();
});
