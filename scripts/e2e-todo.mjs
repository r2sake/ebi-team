// 受け入れ e2e: ボスの TODO（docs/plans/boss-todo-plan.md）。
//
// 確認すること:
//   (1) master 専用 MCP に todo_add / todo_list / todo_get / todo_resolve が出て、engineer ロールには出ない
//   (2) MCP todo_add → WS `todos` に載る（トップバーの件数・一覧の元）。todo_list は詳細を含まない・todo_get は含む
//   (3) Origin の無い WS（ブラウザ以外）からの todoAnswer は弾かれ、TODO は残る
//   (4) 同一オリジンのブラウザ相当の WS で todoAnswer → master のチャットに `[TODO #N への回答] …` が
//       ボスの発話として届き、TODO は消える（WS `todos` が空になる）。todo_get は「解決済み」
//   (5) チャットで答えた想定: MCP todo_resolve → WS `todos` から消える
//   (6) 「✓ 対応した」→ `[TODO #N 対応済み] …` が届いて消える
//   (7) サーバを再起動しても未解決の TODO と次の番号が戻る（番号は使い回さない）
//
// 実行:
//   node scripts/e2e-todo.mjs
//
// 枠の使い方: 実 claude は使わない（偽 claude スタブ scripts/fake-claude-stream.mjs）。
// 安全条件:
//  - 稼働中のサーバ（127.0.0.1:8787）には触らない。専用ポート 8833 を使う。
//  - 生成物はすべて mkdtemp 配下。停止は PID 指定（srv.kill）。

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PORT = Number(process.env.EBI_E2E_TODO_PORT ?? 8833);
if (PORT === 8787) throw new Error("稼働中のサーバと同じポートは使わない");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (m) => { results.push(true); console.log("  OK:", m); };
const fail = (m) => { results.push(false); console.error("  NG:", m); };

const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "ebi-e2e-todo-")));
const TODOS_PATH = join(tmpDir, "todos.json");

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

const binDir = writeFakeClaude();
const configPath = writeConfig();
const masterMcpPath = writeMasterMcp();

function startServer() {
  const proc = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      EBI_PORT: String(PORT),
      EBI_HOST: "127.0.0.1",
      EBI_CONTROL_URL: `http://127.0.0.1:${PORT}`,
      EBI_CONFIG_PATH: configPath,
      EBI_MASTER_MCP_CONFIG: masterMcpPath,
      EBI_DUMP_PATH: join(tmpDir, "registry.json"),
      EBI_DELIVERY_LOG_PATH: "off",
      EBI_FIXED_EBI_LOG_PATH: "off",
      EBI_USAGE_HISTORY_PATH: join(tmpDir, "usage-history.jsonl"),
      EBI_MASTER_CHAT_LOG_PATH: join(tmpDir, "master-chat.jsonl"),
      EBI_CHAT_ATTACH_DIR: join(tmpDir, "chat-attachments"),
      EBI_VIEWERS_PATH: join(tmpDir, "viewers.json"),
      EBI_VIEWER_ROOTS: tmpDir,
      EBI_FILE_EDIT_LOG_PATH: join(tmpDir, "file-edits.jsonl"),
      EBI_TODOS_PATH: TODOS_PATH,
      EBI_IDLE_NOTIFY: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  return proc;
}

async function stopServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((r) => proc.once("exit", r));
  proc.kill("SIGTERM");
  await Promise.race([exited, sleep(8000)]);
  if (proc.exitCode === null) proc.kill("SIGKILL");
}

/** WS を開く。browser=true なら同一オリジンの Origin を付ける（ブラウザ相当）。 */
async function openWs(browser) {
  const headers = browser ? { Origin: `http://127.0.0.1:${PORT}` } : {};
  const ws = await new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers });
    w.on("open", () => res(w));
    w.on("error", rej);
  });
  const state = { msgs: [], events: [], states: [], todos: [] };
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    state.msgs.push(msg);
    if (msg.type === "chatEvent") state.events.push(msg.event);
    if (msg.type === "chatState") state.states.push(msg);
    if (msg.type === "todos") state.todos.push(msg.items);
  });
  return { ws, state };
}

async function openWsRetry(browser) {
  for (let i = 0; i < 30; i++) {
    try { return await openWs(browser); } catch { await sleep(500); }
  }
  throw new Error("WS に繋がらない");
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

const lastTodos = (client) => client.state.todos[client.state.todos.length - 1] ?? null;
const text = (r) => r.content?.[0]?.text ?? "";

async function connectMcp(role) {
  const c = new Client({ name: `e2e-todo-${role}`, version: "0.1.0" }, { capabilities: {} });
  await c.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(ROOT, "src/mcp/control-server.ts")],
    cwd: ROOT,
    env: { ...process.env, EBI_CONTROL_URL: `http://127.0.0.1:${PORT}`, EBI_MCP_ROLE: role, EBI_ID: role === "master" ? "master" : "ebi-x", EBI_NOTIFY_SUBSCRIBE: "off" },
  }));
  return c;
}

let srv = null;
let mcp = null;
const clients = [];
try {
  srv = startServer();
  const browser = await openWsRetry(true);
  clients.push(browser);
  const idle = await waitFor(() => browser.state.states.find((s) => s.state === "idle"), 60_000);
  if (idle) ok("chat master が idle になった");
  else throw new Error("chat master が起動しない");
  if (lastTodos(browser)?.length === 0) ok("接続直後に WS todos（空）が届く");
  else fail(`接続直後の todos が不正: ${JSON.stringify(lastTodos(browser))}`);

  // ---- (1) MCP ツールの出し分け ----
  const TODO_TOOLS = ["todo_add", "todo_list", "todo_get", "todo_resolve"];
  const eng = await connectMcp("engineer");
  const engTools = (await eng.listTools()).tools.map((t) => t.name);
  await eng.close();
  if (TODO_TOOLS.every((t) => !engTools.includes(t))) ok("engineer ロールの MCP に todo_* は出ない");
  else fail(`engineer に todo_* が出ている: ${engTools.join(", ")}`);
  mcp = await connectMcp("master");
  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  if (TODO_TOOLS.every((t) => tools.includes(t))) ok("master ロールの MCP に todo_* が 4 本出る");
  else fail(`master の todo_* が足りない: ${tools.join(", ")}`);

  // ---- (2) 追加 → 一覧・詳細 ----
  const added = await mcp.callTool({
    name: "todo_add",
    arguments: {
      title: "PR #9 をマージしてよいか",
      detail: "**差分**は 3 ファイル。",
      kind: "question",
      ebi: "engineer-3",
      project: "ebi-team",
      options: [{ label: "マージする" }, { label: "待つ", description: "週明けに" }],
      recommended: "マージする",
    },
  });
  const no1 = Number(/"no": (\d+)/.exec(text(added))?.[1]);
  const shown = await waitFor(() => lastTodos(browser)?.find((t) => t.no === no1));
  if (!added.isError && no1 === 1 && shown?.recommended === "マージする") ok("todo_add → #1 が WS todos に載る（推奨つき）");
  else fail(`todo_add が不正: ${text(added)}`);
  const listed = await mcp.callTool({ name: "todo_list", arguments: {} });
  if (/"count": 1/.test(text(listed)) && !text(listed).includes("差分")) ok("todo_list は件数と件名だけ（詳細を含まない）");
  else fail(`todo_list が不正: ${text(listed)}`);
  const got = await mcp.callTool({ name: "todo_get", arguments: { no: 1 } });
  if (!got.isError && text(got).includes("差分") && text(got).includes("週明けに")) ok("todo_get(1) は詳細・選択肢まで返す");
  else fail(`todo_get が不正: ${text(got)}`);
  const bad = await mcp.callTool({ name: "todo_add", arguments: { title: "x", kind: "question", options: [{ label: "A" }], recommended: "Z" } });
  if (bad.isError) ok("options に無い recommended は todo_add で弾かれる");
  else fail(`不正な recommended が通った: ${text(bad)}`);

  // ---- (3) ブラウザ以外の WS からは答えられない ----
  const bot = await openWsRetry(false);
  clients.push(bot);
  const denied = await roundtrip(bot, { type: "todoAnswer", no: 1, choice: "マージする" }, "todoAnswerResult");
  if (denied?.type === "todoAnswerResult" && denied.ok === false && lastTodos(browser)?.length === 1) {
    ok("Origin の無い WS の todoAnswer は弾かれ、TODO は残る");
  } else fail(`ブラウザ以外の回答が通った: ${JSON.stringify(denied)}`);

  // ---- (4) UI から回答 → master へ届いて消える ----
  let from = browser.state.events.length;
  const answered = await roundtrip(browser, { type: "todoAnswer", no: 1, choice: "マージする", text: "急ぎで" }, "todoAnswerResult");
  const userEv = await waitFor(() => browser.state.events.slice(from).find((e) => e.kind === "user" && e.text.includes("[TODO #1 への回答]")));
  const cleared = await waitFor(() => lastTodos(browser)?.length === 0);
  if (answered?.ok === true && userEv && /選択: マージする/.test(userEv.text) && /補足: 急ぎで/.test(userEv.text) && cleared) {
    ok("todoAnswer → チャットに「[TODO #1 への回答] … 選択・補足」が届き、一覧から消える");
  } else fail(`UI からの回答が不正: result=${JSON.stringify(answered)} user=${JSON.stringify(userEv)}`);
  const gone = await mcp.callTool({ name: "todo_get", arguments: { no: 1 } });
  if (gone.isError && text(gone).includes("解決済み")) ok("解決した #1 を todo_get すると「解決済み」");
  else fail(`解決済みの扱いが不正: ${text(gone)}`);

  // ---- (5) チャットで答えた想定: todo_resolve ----
  const a2 = await mcp.callTool({ name: "todo_add", arguments: { title: "Cloudflare の権限を許可", kind: "permission" } });
  const no2 = Number(/"no": (\d+)/.exec(text(a2))?.[1]);
  await waitFor(() => lastTodos(browser)?.some((t) => t.no === no2));
  const r2 = await mcp.callTool({ name: "todo_resolve", arguments: { no: no2 } });
  const cleared2 = await waitFor(() => lastTodos(browser)?.length === 0);
  if (no2 === 2 && !r2.isError && cleared2) ok("todo_add は #2（使い回さない）・todo_resolve で一覧から消える");
  else fail(`todo_resolve が不正: no=${no2} ${text(r2)}`);

  // ---- (6) 「✓ 対応した」 ----
  const a3 = await mcp.callTool({ name: "todo_add", arguments: { title: "env を置く", kind: "action" } });
  const no3 = Number(/"no": (\d+)/.exec(text(a3))?.[1]);
  await waitFor(() => lastTodos(browser)?.some((t) => t.no === no3));
  from = browser.state.events.length;
  const done = await roundtrip(browser, { type: "todoAnswer", no: no3, done: true }, "todoAnswerResult");
  const doneEv = await waitFor(() => browser.state.events.slice(from).find((e) => e.kind === "user" && e.text.includes(`[TODO #${no3} 対応済み]`)));
  if (done?.ok === true && doneEv && (await waitFor(() => lastTodos(browser)?.length === 0))) ok(`「✓ 対応した」→ [TODO #${no3} 対応済み] が届いて消える`);
  else fail(`対応済みが不正: ${JSON.stringify(done)}`);

  // ---- (7) 再起動で戻る ----
  const a4 = await mcp.callTool({ name: "todo_add", arguments: { title: "再起動をまたぐ", kind: "question" } });
  const no4 = Number(/"no": (\d+)/.exec(text(a4))?.[1]);
  await mcp.close();
  mcp = null;
  for (const c of clients.splice(0)) c.ws.close();
  await stopServer(srv);
  srv = startServer();
  const after = await openWsRetry(true);
  clients.push(after);
  const restored = await waitFor(() => lastTodos(after));
  if (restored?.length === 1 && restored[0].no === no4) ok(`再起動後も未解決の #${no4} が WS todos に戻る`);
  else fail(`再起動後の todos が不正: ${JSON.stringify(restored)}`);
  await waitFor(() => after.state.states.find((s) => s.state === "idle"), 60_000);
  mcp = await connectMcp("master");
  const a5 = await mcp.callTool({ name: "todo_add", arguments: { title: "続きの番号", kind: "action" } });
  const no5 = Number(/"no": (\d+)/.exec(text(a5))?.[1]);
  if (no5 === no4 + 1) ok(`再起動後の番号は続きから（#${no5}）`);
  else fail(`再起動後の番号が不正: ${no5}`);
} catch (err) {
  fail(`例外: ${err.stack ?? err}`);
} finally {
  try { await mcp?.close(); } catch {}
  for (const c of clients) { try { c.ws.close(); } catch {} }
  await stopServer(srv);
  rmSync(tmpDir, { recursive: true, force: true });
  const pass = results.filter(Boolean).length;
  console.log(`\n==== e2e todo: ${pass}/${results.length} OK ====`);
  process.exit(pass === results.length && results.length > 0 ? 0 : 1);
}
