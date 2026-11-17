// 受け入れ e2e: ボスが UI からファイル（主に env）を書き換える機能。
//
// 確認すること:
//   (1) master 専用 MCP に request_file_edit が出て、engineer ロールには出ない
//   (2) MCP request_file_edit → チャットに入力カード（fileEditRequest）が出る。値は載らない
//       許可ルート外・不正な鍵名は MCP の時点で拒否される
//   (3) Origin の無い WS（ブラウザ以外）からは fileEditOpen / fileEditSave できない
//   (4) 同一オリジンのブラウザ相当の WS で 開く → 保存（新規作成＋フォルダ作成）できる
//       → カードが saved で畳まれ、master には [file-edit <id>] の結果だけが届く（値は届かない）
//   (5) 既存ファイルの上書き: 控え（.bak-日時）が残る / 開いた後の他所の変更は conflict で保存しない
//   (6) 依頼の見送り → master に「見送り」が届く
//   (7) 値が会話ログ（master-chat.jsonl）・書き込み記録（file-edits.jsonl）のどちらにも残らない
//
// 実行:
//   node scripts/e2e-file-editor.mjs
//
// 枠の使い方: 実 claude は使わない（偽 claude スタブ scripts/fake-claude-stream.mjs）。
// 安全条件:
//  - 稼働 control API（127.0.0.1:8787）には触らない。専用ポート 8816 を使う。
//  - 生成物・許可ルートはすべて mkdtemp 配下。停止は PID 指定（srv.kill）。

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PORT = Number(process.env.EBI_E2E_FILE_EDIT_PORT ?? 8816);
const SECRET = "e2e-super-secret-VALUE-9f3a";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (m) => { results.push(true); console.log("  OK:", m); };
const fail = (m) => { results.push(false); console.error("  NG:", m); };

const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "ebi-e2e-file-edit-")));
const editRoot = join(tmpDir, "config-root");
const outside = join(tmpDir, "outside");
mkdirSync(editRoot, { recursive: true });
mkdirSync(outside, { recursive: true });

function writeConfig() {
  const p = join(tmpDir, "config.json");
  const master = {
    id: "master",
    kind: "master",
    brain: "claude",
    cwd: ROOT,
    model: "haiku",
    permissionMode: "auto",
    appendSystemPrompt: "テスト用",
    ui: "chat",
  };
  writeFileSync(p, `${JSON.stringify({ fixedEbi: [master] }, null, 2)}\n`);
  return p;
}

function writeMasterMcp() {
  const p = join(tmpDir, "master-control.e2e.mcp.json");
  writeFileSync(
    p,
    `${JSON.stringify({
      mcpServers: {
        "ebi-control": {
          command: process.execPath,
          args: ["--import", "tsx", join(ROOT, "src/mcp/control-server.ts")],
          cwd: ROOT,
          env: { EBI_CONTROL_URL: `http://127.0.0.1:${PORT}`, EBI_MCP_ROLE: "master", EBI_NOTIFY_SUBSCRIBE: "off" },
        },
      },
    }, null, 2)}\n`,
  );
  return p;
}

function writeFakeClaude() {
  const binDir = join(tmpDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const p = join(binDir, "claude");
  writeFileSync(p, `#!/bin/sh\nexec ${process.execPath} ${join(ROOT, "scripts/fake-claude-stream.mjs")} "$@"\n`);
  chmodSync(p, 0o755);
  return binDir;
}

function startServer() {
  const proc = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${writeFakeClaude()}:${process.env.PATH}`,
      EBI_PORT: String(PORT),
      EBI_HOST: "127.0.0.1",
      EBI_CONTROL_URL: `http://127.0.0.1:${PORT}`,
      EBI_CONFIG_PATH: writeConfig(),
      EBI_MASTER_MCP_CONFIG: writeMasterMcp(),
      EBI_DUMP_PATH: join(tmpDir, "registry.json"),
      EBI_DELIVERY_LOG_PATH: "off",
      EBI_FIXED_EBI_LOG_PATH: "off",
      EBI_USAGE_HISTORY_PATH: join(tmpDir, "usage-history.jsonl"),
      EBI_MASTER_CHAT_LOG_PATH: join(tmpDir, "master-chat.jsonl"),
      EBI_CHAT_ATTACH_DIR: join(tmpDir, "chat-attachments"),
      EBI_VIEWERS_PATH: join(tmpDir, "viewers.json"),
      EBI_VIEWER_ROOTS: tmpDir,
      EBI_EDIT_ROOTS: editRoot,
      EBI_FILE_EDIT_LOG_PATH: join(tmpDir, "file-edits.jsonl"),
      EBI_IDLE_NOTIFY: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  return proc;
}

/** WS を開く。browser=true なら同一オリジンの Origin を付ける（ブラウザ相当）。 */
async function openWs(browser) {
  const headers = browser ? { Origin: `http://127.0.0.1:${PORT}` } : {};
  const ws = await new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers });
    w.on("open", () => res(w));
    w.on("error", rej);
  });
  const state = { msgs: [], events: [], states: [] };
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    state.msgs.push(msg);
    if (msg.type === "chatEvent") state.events.push(msg.event);
    if (msg.type === "chatState") state.states.push(msg);
  });
  return { ws, state };
}

async function waitFor(fn, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= until) return null;
    await sleep(100);
  }
}

/** WS で 1 往復（送って、type が一致する最初の新着を待つ）。 */
async function roundtrip(client, msg, type) {
  const from = client.state.msgs.length;
  client.ws.send(JSON.stringify(msg));
  return waitFor(() => client.state.msgs.slice(from).find((m) => m.type === type || m.type === "error"));
}

let srv = null;
let mcp = null;
const clients = [];
try {
  srv = startServer();
  const browser = await openWs(true).catch(async () => { await sleep(3000); return openWs(true); });
  clients.push(browser);
  const idle = await waitFor(() => browser.state.states.find((s) => s.state === "idle"), 60_000);
  if (idle) ok("chat master が idle になった");
  else throw new Error("chat master が起動しない");

  // ---- (1) MCP ツールの出し分け ----
  const connectMcp = async (role) => {
    const c = new Client({ name: `e2e-file-edit-${role}`, version: "0.1.0" }, { capabilities: {} });
    await c.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", join(ROOT, "src/mcp/control-server.ts")],
      cwd: ROOT,
      env: { ...process.env, EBI_CONTROL_URL: `http://127.0.0.1:${PORT}`, EBI_MCP_ROLE: role, EBI_ID: role === "master" ? "master" : "ebi-x", EBI_NOTIFY_SUBSCRIBE: "off" },
    }));
    return c;
  };
  const eng = await connectMcp("engineer");
  const engTools = (await eng.listTools()).tools.map((t) => t.name);
  await eng.close();
  if (!engTools.includes("request_file_edit")) ok("engineer ロールの MCP に request_file_edit は出ない");
  else fail("engineer に request_file_edit が出ている");
  mcp = await connectMcp("master");
  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  if (tools.includes("request_file_edit")) ok("master ロールの MCP に request_file_edit が出る");
  else fail(`request_file_edit が無い: ${tools.join(", ")}`);

  // ---- (2) 依頼 → カード ----
  const envPath = join(editRoot, "webgame-guide", "prd.env");
  let from = browser.state.events.length;
  const called = await mcp.callTool({
    name: "request_file_edit",
    arguments: { path: envPath, keys: ["CLOUDFLARE_API_TOKEN"], note: "CF のトークンを入れてください" },
  });
  const calledText = called.content?.[0]?.text ?? "";
  const reqId = /"requestId": "([^"]+)"/.exec(calledText)?.[1];
  const card = await waitFor(() => browser.state.events.slice(from).find((e) => e.kind === "fileEditRequest"));
  if (!called.isError && reqId && /"status": "pending"/.test(calledText) && card?.id === reqId) {
    ok(`MCP request_file_edit → チャットに入力カードが出る（${reqId}）`);
  } else {
    fail(`依頼カードが出ない: ${calledText.slice(0, 300)}`);
  }
  if (card && JSON.stringify(card.keys) === '["CLOUDFLARE_API_TOKEN"]' && card.path === envPath) ok("カードは鍵名とパスだけを持つ");
  else fail(`カードの中身が想定外: ${JSON.stringify(card)}`);
  const outsideReq = await mcp.callTool({ name: "request_file_edit", arguments: { path: join(outside, "x.env") } });
  if (outsideReq.isError && /許可ルートの外/.test(outsideReq.content?.[0]?.text ?? "")) ok("許可ルート外の依頼は MCP の時点で拒否");
  else fail("許可ルート外の依頼が通った");
  const badKey = await mcp.callTool({ name: "request_file_edit", arguments: { path: envPath, keys: ["bad key"] } });
  if (badKey.isError) ok("不正な鍵名の依頼は拒否");
  else fail("不正な鍵名が通った");

  // ---- (3) Origin の無い WS は書けない ----
  const raw = await openWs(false);
  clients.push(raw);
  const rawOpen = await roundtrip(raw, { type: "fileEditOpen", path: envPath, requestId: reqId }, "fileEditLoaded");
  const rawSave = await roundtrip(
    raw,
    { type: "fileEditSave", path: envPath, content: `X=${SECRET}\n`, baseHash: null, createDirs: true, backup: false },
    "fileEditSaved",
  );
  if (rawOpen?.type === "error" && rawSave?.type === "error" && !existsSync(envPath)) {
    ok("Origin の無い WS（ブラウザ以外）は開けず・書けない");
  } else {
    fail(`Origin 無しで通った: ${JSON.stringify(rawOpen)} / ${JSON.stringify(rawSave)}`);
  }

  // ---- (4) ブラウザ相当で 開く → 保存（新規＋フォルダ作成）----
  const loaded = await roundtrip(browser, { type: "fileEditOpen", path: envPath, requestId: reqId }, "fileEditLoaded");
  const view = loaded?.file;
  if (view && view.exists === false && view.secret === true && view.missingDirs.length === 1) {
    ok("依頼のファイルを開ける（新規・秘密ファイル判定・作るフォルダ 1 つ）");
  } else {
    fail(`開けない: ${JSON.stringify(loaded)}`);
  }
  const noDirs = await roundtrip(
    browser,
    { type: "fileEditSave", path: envPath, content: `CLOUDFLARE_API_TOKEN=${SECRET}\n`, baseHash: null, createDirs: false, backup: true, requestId: reqId },
    "fileEditSaved",
  );
  if (noDirs?.error && /親フォルダ/.test(noDirs.error)) ok("フォルダ作成の確認なしでは保存しない");
  else fail(`フォルダ確認なしで通った: ${JSON.stringify(noDirs)}`);
  const otherPath = await roundtrip(
    browser,
    { type: "fileEditSave", path: join(editRoot, "other.env"), content: "A=1\n", baseHash: null, createDirs: true, backup: false, requestId: reqId },
    "fileEditSaved",
  );
  if (otherPath?.error && !existsSync(join(editRoot, "other.env"))) ok("依頼と違うファイルには保存できない");
  else fail(`依頼と違うファイルに保存できた: ${JSON.stringify(otherPath)}`);

  from = browser.state.events.length;
  const saved = await roundtrip(
    browser,
    { type: "fileEditSave", path: envPath, content: `CLOUDFLARE_API_TOKEN=${SECRET}\n`, baseHash: null, createDirs: true, backup: true, requestId: reqId },
    "fileEditSaved",
  );
  const fileOk = existsSync(envPath) && readFileSync(envPath, "utf8") === `CLOUDFLARE_API_TOKEN=${SECRET}\n`;
  if (saved?.saved?.action === "create" && fileOk && (statSync(envPath).mode & 0o777) === 0o600) {
    ok("保存できた（新規作成・0600）");
  } else {
    fail(`保存できない: ${JSON.stringify(saved)}`);
  }
  if (saved && !JSON.stringify(saved).includes(SECRET)) ok("保存の応答に値が入っていない");
  else fail("保存の応答に値が入っている");
  const settled = await waitFor(() => browser.state.events.slice(from).find((e) => e.kind === "fileEditSettled" && e.id === reqId));
  const inbound = await waitFor(() => browser.state.events.slice(from).find((e) => e.kind === "inbound" && e.text.includes(`[file-edit ${reqId}]`)));
  if (settled?.outcome === "saved") ok("カードが saved で畳まれる");
  else fail(`カードが畳まれない: ${JSON.stringify(settled)}`);
  if (inbound && inbound.from === "file-editor" && inbound.text.includes("CLOUDFLARE_API_TOKEN") && !inbound.text.includes(SECRET)) {
    ok(`master に結果だけが届く: ${inbound.text}`);
  } else {
    fail(`master への通知が想定外: ${JSON.stringify(inbound)}`);
  }
  const again = await roundtrip(browser, { type: "fileEditOpen", path: envPath, requestId: reqId }, "fileEditLoaded");
  if (again?.error && /無効/.test(again.error)) ok("決着した依頼からはもう開けない");
  else fail(`決着後も依頼で開けた: ${JSON.stringify(again)}`);

  // ---- (5) 自由編集: 上書き・控え・競合 ----
  const o1 = await roundtrip(browser, { type: "fileEditOpen", path: envPath }, "fileEditLoaded");
  const s1 = await roundtrip(
    browser,
    { type: "fileEditSave", path: envPath, content: `CLOUDFLARE_API_TOKEN=${SECRET}\nB=2\n`, baseHash: o1?.file?.baseHash ?? null, createDirs: false, backup: true },
    "fileEditSaved",
  );
  const bak = s1?.saved?.backupPath;
  if (s1?.saved?.action === "update" && bak && existsSync(bak) && (statSync(bak).mode & 0o777) === 0o600) {
    ok(`上書きで控えが残る（${bak.split("/").pop()}・権限 0600 を維持）`);
  } else {
    fail(`上書き/控えが想定外: ${JSON.stringify(s1)}`);
  }
  const stale = await roundtrip(
    browser,
    { type: "fileEditSave", path: envPath, content: "C=3\n", baseHash: o1?.file?.baseHash ?? null, createDirs: false, backup: false },
    "fileEditSaved",
  );
  if (stale?.conflict && readFileSync(envPath, "utf8").includes("B=2")) ok("開いた後に変わっていたら conflict で保存しない");
  else fail(`競合が検出されない: ${JSON.stringify(stale)}`);
  const outsideSave = await roundtrip(
    browser,
    { type: "fileEditSave", path: join(outside, "x.env"), content: "A=1\n", baseHash: null, createDirs: true, backup: false },
    "fileEditSaved",
  );
  if (outsideSave?.error && readdirSync(outside).length === 0) ok("ブラウザからでも許可ルート外には書けない");
  else fail(`許可ルート外に書けた: ${JSON.stringify(outsideSave)}`);

  // ---- (6) 見送り ----
  const c2 = await mcp.callTool({ name: "request_file_edit", arguments: { path: join(editRoot, "dev.env"), keys: ["A"] } });
  const reqId2 = /"requestId": "([^"]+)"/.exec(c2.content?.[0]?.text ?? "")?.[1];
  from = browser.state.events.length;
  browser.ws.send(JSON.stringify({ type: "fileEditCancel", requestId: reqId2 }));
  const cancelled = await waitFor(() => browser.state.events.slice(from).find((e) => e.kind === "fileEditSettled" && e.id === reqId2));
  const cancelInbound = await waitFor(() => browser.state.events.slice(from).find((e) => e.kind === "inbound" && e.text.includes(`[file-edit ${reqId2}]`)));
  if (cancelled?.outcome === "cancelled" && cancelInbound?.text.includes("見送り")) ok("見送りは master に「見送り」として届く");
  else fail(`見送りが想定外: ${JSON.stringify(cancelled)} / ${JSON.stringify(cancelInbound)}`);

  // ---- (7) 値がログに残らない ----
  await sleep(1500);
  const chatLog = readFileSync(join(tmpDir, "master-chat.jsonl"), "utf8");
  const auditLog = readFileSync(join(tmpDir, "file-edits.jsonl"), "utf8");
  if (!chatLog.includes(SECRET)) ok("会話ログ（master-chat.jsonl）に値が残らない");
  else fail("会話ログに値が残っている");
  const audit = auditLog.trim().split("\n").map((l) => JSON.parse(l));
  if (!auditLog.includes(SECRET) && audit.length === 2 && audit[0].actor === `boss-ui:request:${reqId}` && audit[1].actor === "boss-ui") {
    ok("書き込み記録は 2 件（依頼経由 / UI 単独）で、値は残らない");
  } else {
    fail(`書き込み記録が想定外: ${auditLog}`);
  }
} catch (err) {
  fail(`例外: ${err?.stack ?? err}`);
} finally {
  for (const c of clients) c.ws.close();
  if (mcp) await mcp.close().catch(() => {});
  if (srv) {
    srv.kill("SIGTERM");
    await sleep(2500);
    if (srv.exitCode === null) srv.kill("SIGKILL");
  }
  rmSync(tmpDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(results.every(Boolean) && results.length > 0 ? 0 : 1);
