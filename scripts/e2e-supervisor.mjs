// Phase3 バッチC の E2E（実 claude 課金なし）。
// EBI_COMMAND=bash + EBI_SUMMARY_CMD でスタブ要約コマンドに差し替えて、
// 要約エンジンを叩く 3 経路が「要約エンジンを実際に呼んで結果を回収する」ことを確認する:
//
//   A. WS `summarize` → `summary` 返却
//   B. POST /control/summarize → { text } 返却
//   C. 制御MCP `ask_supervisor({target_id})` → 要約テキストを回収して返す
//
// 要約エンジンは EBI_SUMMARY_CMD で差し替え可能（本番は未設定＝claude --print）。
// ここではダミースクリプト（入力 prompt を無視し固定文字列を stdout に出す）に差して、
// 実 claude を叩かず・課金させずに「経路が要約エンジンを呼ぶ」ことだけ検証する。

import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { writeFileSync, rmSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const PORT = 8802;
const BASE = `http://127.0.0.1:${PORT}`;
const SUMMARY_MARKER = "STUB_SUMMARY_OK_3LINES";

const tmpDir = mkdtempSync(join(tmpdir(), "ebi-e2e-sup-"));
const configPath = join(tmpDir, "ebi-team.config.json");
// 固定エビは無し（要約はワンショットなので常駐 supervisor に依存しない＝それを検証）。
writeFileSync(configPath, JSON.stringify({ fixedEbi: [] }, null, 2));

// スタブ要約コマンド: 受け取った引数（prompt 等）は無視し、固定マーカーを stdout に出すだけ。
// これにより実 claude を叩かず「要約経路がコマンドを起動し stdout を回収する」ことを確認できる。
const stubPath = join(tmpDir, "stub-summary.sh");
writeFileSync(stubPath, `#!/usr/bin/env bash\necho "${SUMMARY_MARKER}"\n`);
chmodSync(stubPath, 0o755);

const results = [];
const ok = (m) => { results.push(true); console.log("  OK:", m); };
const fail = (m) => { results.push(false); console.error("  NG:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let server;
let ws;
let mcpClient;
let mcpTransport;
async function cleanup(code) {
  try { ws?.close(); } catch {}
  try { await mcpClient?.close(); } catch {}
  try { await mcpTransport?.close(); } catch {}
  try { server?.kill("SIGTERM"); } catch {}
  await sleep(400);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

// ---- 一時サーバ起動（EBI_COMMAND=bash・別ポート・EBI_SUMMARY_CMD でスタブ差し替え）----
server = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    EBI_PORT: String(PORT),
    EBI_COMMAND: "bash",
    EBI_CONFIG_PATH: configPath,
    EBI_DUMP_PATH: join(tmpDir, "registry.json"),
    EBI_IDLE_MS: "300",
    // 要約エンジンをスタブへ差し替える（本番未設定＝claude --print --model haiku）。
    EBI_SUMMARY_CMD: stubPath,
    // ANTHROPIC_API_KEY が無くても要約が動く（API キー非依存）ことを担保するため明示的に消す。
    ANTHROPIC_API_KEY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let srvLog = "";
server.stdout.on("data", (d) => { srvLog += d; process.stdout.write("[srv] " + d); });
server.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));

const overall = setTimeout(() => { fail("全体タイムアウト"); finish(); }, 40000);

async function finish() {
  clearTimeout(overall);
  const okCount = results.filter(Boolean).length;
  console.log(`\n==== バッチC E2E 結果: ${okCount}/${results.length} OK ====`);
  await cleanup(okCount === results.length ? 0 : 1);
}

// WS で 1 体 spawn し、十分な scrollback を貯めてから対象 id を返す。
function wsConnect() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let capSupervisor = null;
    let spawnedId = null;
    const summaries = [];
    ws.on("open", () => {});
    ws.on("error", reject);
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "capabilities") capSupervisor = msg.supervisor;
      if (msg.type === "spawned") spawnedId = msg.agent.id;
      if (msg.type === "summary") summaries.push(msg);
    });
    resolve({
      get capSupervisor() { return capSupervisor; },
      get spawnedId() { return spawnedId; },
      summaries,
      send: (m) => ws.send(JSON.stringify(m)),
    });
  });
}

async function main() {
  await sleep(2500); // サーバ起動待ち

  // capabilities=true が起動ログに出ているか（スタブなので有効になるはず）。
  if (/監督・要約: 有効（スタブ/.test(srvLog)) {
    ok("起動ログ: 監督・要約 有効（スタブ要約エンジン認識）");
  } else {
    fail("起動ログに『監督・要約: 有効（スタブ』が出ない: " + srvLog.slice(-300));
  }

  const wsc = await wsConnect();
  await sleep(800);
  if (wsc.capSupervisor === true) {
    ok("capabilities.supervisor=true（claude 有無=スタブで判定・API キー不要）");
  } else {
    fail("capabilities.supervisor が true でない: " + wsc.capSupervisor);
  }

  // bash エビを 1 体 spawn し、MIN_INPUT_CHARS を超える scrollback を貯める。
  wsc.send({ type: "spawn", cwd: root });
  await sleep(1500);
  const target = wsc.spawnedId;
  if (!target) { fail("spawn 応答（spawned）が来ない"); return finish(); }
  ok(`spawn（要約対象エビ ${target} を起動）`);

  // scrollback を稼ぐ（MIN_INPUT_CHARS=40 を超えるよう複数行出力させる）。
  wsc.send({ type: "input", id: target, data: "for i in 1 2 3 4 5 6 7 8; do echo line_$i_padding_text; done\r" });
  await sleep(1500);

  // ===== A. WS summarize → summary =====
  console.log("\n--- A. WS summarize → summary ---");
  wsc.send({ type: "summarize", id: target });
  await sleep(1500);
  const sumMsg = wsc.summaries.find((s) => s.id === target);
  if (sumMsg && sumMsg.text.includes(SUMMARY_MARKER)) {
    ok("WS summarize → summary（要約エンジン stdout を回収）");
  } else {
    fail("WS summary が来ない/マーカー不一致: " + JSON.stringify(sumMsg));
  }

  // ===== B. POST /control/summarize =====
  console.log("\n--- B. POST /control/summarize ---");
  {
    const r = await postJson("/control/summarize", { id: target });
    if (r.status === 200 && (r.body?.text ?? "").includes(SUMMARY_MARKER)) {
      ok("POST /control/summarize（{ text } で要約回収）");
    } else {
      fail("POST /control/summarize 失敗: " + JSON.stringify(r));
    }
    // 存在しない id は 404。
    const r2 = await postJson("/control/summarize", { id: "no-such-ebi" });
    if (r2.status === 404) {
      ok("POST /control/summarize（不在 id は 404）");
    } else {
      fail("不在 id が 404 でない: " + JSON.stringify(r2));
    }
  }

  // ===== C. 制御MCP ask_supervisor =====
  console.log("\n--- C. 制御MCP ask_supervisor ---");
  mcpTransport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/control-server.ts"],
    cwd: root,
    env: { ...process.env, EBI_CONTROL_URL: BASE },
  });
  mcpClient = new Client({ name: "e2e-sup-client", version: "0.0.1" });
  await mcpClient.connect(mcpTransport);
  {
    const res = await mcpClient.callTool({ name: "ask_supervisor", arguments: { target_id: target } });
    const text = res.content?.[0]?.text ?? "";
    if (!res.isError && text.includes(SUMMARY_MARKER)) {
      ok("ask_supervisor（要約テキストを構造的に回収して返す）");
    } else {
      fail("ask_supervisor が要約を返さない: " + text);
    }
  }

  await finish();
}

main().catch(async (e) => { fail("例外: " + (e?.stack ?? e)); await finish(); });
