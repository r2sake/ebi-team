// e2e: DNS リバインディング対策（loopback の無認証を Host が localhost 等のときだけに限る）。
//
// 確かめること（EBI_HOST=0.0.0.0・EBI_AUTH_TOKEN あり＝ボスの実運用と同じ形で立てる）:
//   (1) loopback から Host: localhost / 127.0.0.1 / [::1] → 今までどおり無認証で通る（HTTP・WS）
//   (2) loopback から別名の Host（リバインドされたドメイン・0.0.0.0）→ 認証を求める（401 / /login へ 302）。
//       トークン（Bearer / Cookie / ?token=）があれば通る
//   (3) 非 loopback（Tailscale / LAN のアドレス）から Host: mac-mini → トークンが無ければ 401、あれば通る
//   (4) statusLine の報告（curl → 127.0.0.1/control/usage）と ebi-control MCP（127.0.0.1）が通る
//
// 実行: npm run e2e:dns-rebind
//  - 稼働中のサーバには触らない。専用ポート（既定 8827）で立て、自分が起動した PID だけ止める。
//  - 固定エビは起動しない（fixedEbi: []）。生成物は mkdtemp 配下。

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PORT = Number(process.env.EBI_E2E_REBIND_PORT ?? 8827);
const TOKEN = "e2e-rebind-token";
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (m) => { results.push(true); console.log("  OK:", m); };
const fail = (m) => { results.push(false); console.error("  NG:", m); };
const check = (cond, m, detail = "") => (cond ? ok(m) : fail(`${m} ${detail}`));

const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "ebi-e2e-rebind-")));

function startServer() {
  const configPath = join(tmpDir, "config.json");
  writeFileSync(configPath, `${JSON.stringify({ fixedEbi: [] }, null, 2)}\n`);
  const proc = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      EBI_PORT: String(PORT),
      EBI_HOST: "0.0.0.0",
      EBI_CONTROL_URL: BASE,
      EBI_CONFIG_PATH: configPath,
      EBI_DUMP_PATH: join(tmpDir, "registry.json"),
      EBI_DELIVERY_LOG_PATH: "off",
      EBI_FIXED_EBI_LOG_PATH: "off",
      EBI_USAGE_HISTORY_PATH: join(tmpDir, "usage-history.jsonl"),
      EBI_MASTER_CHAT_LOG_PATH: join(tmpDir, "master-chat.jsonl"),
      EBI_CHAT_ATTACH_DIR: join(tmpDir, "chat-attachments"),
      EBI_VIEWERS_PATH: join(tmpDir, "viewers.json"),
      EBI_VIEWER_ROOTS: tmpDir,
      EBI_FILE_EDIT_LOG_PATH: join(tmpDir, "file-edits.jsonl"),
      EBI_IDLE_NOTIFY: "off",
      EBI_AUTH_TOKEN: TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  return proc;
}

/** 接続先アドレスと Host ヘッダを別々に指定して HTTP を叩く（fetch は Host を上書きできないため）。 */
function httpReq({ addr = "127.0.0.1", host, path = "/control/agents", method = "GET", headers = {}, body }) {
  return new Promise((res, rej) => {
    const r = request({ host: addr, port: PORT, path, method, headers: { ...(host ? { Host: host } : {}), ...headers } }, (resp) => {
      resp.resume();
      resp.on("end", () => res({ status: resp.statusCode, location: resp.headers.location }));
    });
    r.on("error", rej);
    if (body) r.write(body);
    r.end();
  });
}

/** WS を開いて、開けたら最初の registry を待つ。拒否されたら HTTP ステータスを返す。 */
function tryWs({ addr = "127.0.0.1", host, query = "", headers = {} }) {
  return new Promise((res) => {
    const url = `ws://${addr.includes(":") ? `[${addr}]` : addr}:${PORT}/ws${query}`;
    const w = new WebSocket(url, { headers: { ...(host ? { Host: host } : {}), ...headers } });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; res(v); } };
    w.on("message", (raw) => {
      try {
        if (JSON.parse(raw.toString()).type === "registry") { w.close(); done({ open: true }); }
      } catch { /* ignore */ }
    });
    w.on("unexpected-response", (_req, r) => { done({ open: false, status: r.statusCode }); w.terminate(); });
    w.on("error", (e) => done({ open: false, error: e.message }));
    setTimeout(() => { w.terminate(); done({ open: false, error: "timeout" }); }, 10_000);
  });
}

/** 母艦の非 loopback な IPv4（Tailscale の 100.x を優先、無ければ LAN）。 */
function externalAddr() {
  const addrs = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal);
  return (addrs.find((a) => a.address.startsWith("100.")) ?? addrs[0])?.address ?? null;
}

async function waitServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await httpReq({ host: `127.0.0.1:${PORT}` });
      if (r.status === 200) return;
    } catch { /* not yet */ }
    await sleep(200);
  }
  throw new Error("サーバが起動しない");
}

let srv = null;
let mcp = null;
try {
  srv = startServer();
  await waitServer();

  // ---- (1) loopback + ローカルの Host → 無認証で通る ----
  for (const h of [`localhost:${PORT}`, `127.0.0.1:${PORT}`, "localhost"]) {
    const r = await httpReq({ host: h });
    check(r.status === 200, `制御API: loopback + Host ${h} は無認証で 200`, String(r.status));
  }
  // 0.0.0.0 待ち受けは IPv4 のみなので、Host: [::1] の判定は 127.0.0.1 への接続で確かめる。
  const r6 = await httpReq({ host: `[::1]:${PORT}` });
  check(r6.status === 200, "制御API: loopback + Host [::1] は無認証で 200", String(r6.status));
  let w = await tryWs({ host: `localhost:${PORT}`, headers: { Origin: `http://localhost:${PORT}` } });
  check(w.open, "WS: loopback + Host localhost（同一オリジンのブラウザ）は無認証で通る", JSON.stringify(w));
  w = await tryWs({});
  check(w.open, "WS: Origin の無い Node のクライアント（Host 127.0.0.1）は無認証で通る", JSON.stringify(w));

  // ---- (2) loopback + 別名の Host → 認証を求める ----
  const EVIL = `rebind.evil.example:${PORT}`;
  let r = await httpReq({ host: EVIL });
  check(r.status === 401, "制御API: loopback + リバインドされた Host は 401", String(r.status));
  r = await httpReq({ host: EVIL, path: "/control/kill", method: "POST", headers: { Origin: `http://${EVIL}`, "Content-Type": "text/plain" }, body: '{"id":"nobody"}' });
  check(r.status === 401, "制御API: loopback + リバインドされた Host（同一オリジン扱い）の POST も 401", String(r.status));
  r = await httpReq({ host: EVIL, path: "/", headers: { Accept: "text/html" } });
  check(r.status === 302 && r.location === "/login", "UI: loopback + リバインドされた Host はログイン画面へ 302（拒否ではなく認証を求める）", JSON.stringify(r));
  r = await httpReq({ host: `0.0.0.0:${PORT}` });
  check(r.status === 401, "制御API: loopback + Host 0.0.0.0 も 401", String(r.status));
  w = await tryWs({ host: EVIL, headers: { Origin: `http://${EVIL}` } });
  check(!w.open && w.status === 401, "WS: loopback + リバインドされた Host（Origin も一致）は 401", JSON.stringify(w));
  r = await httpReq({ host: EVIL, headers: { Authorization: `Bearer ${TOKEN}` } });
  check(r.status === 200, "制御API: 別名の Host でも Bearer トークンがあれば 200", String(r.status));
  r = await httpReq({ host: EVIL, headers: { Authorization: "Bearer wrong" } });
  check(r.status === 401, "制御API: 別名の Host で誤ったトークンは 401", String(r.status));
  w = await tryWs({ host: EVIL, headers: { Origin: `http://${EVIL}`, Cookie: `ebi_auth=${TOKEN}` } });
  check(w.open, "WS: 別名の Host でも Cookie のトークンがあれば通る", JSON.stringify(w));

  // ---- (3) 非 loopback（Tailscale / LAN）から Host: mac-mini ----
  const ext = externalAddr();
  if (!ext) {
    fail("非 loopback の IPv4 が見つからない（Tailscale / LAN 未接続）");
  } else {
    console.log(`  （非 loopback の確認に ${ext} を使用）`);
    const MM = `mac-mini:${PORT}`;
    r = await httpReq({ addr: ext, host: MM });
    check(r.status === 401, "制御API: Tailscale 相当（mac-mini）・トークン無しは 401", String(r.status));
    r = await httpReq({ addr: ext, host: `localhost:${PORT}` });
    check(r.status === 401, "制御API: 非 loopback は Host が localhost でもトークン無しは 401", String(r.status));
    r = await httpReq({ addr: ext, host: MM, headers: { Cookie: `ebi_auth=${TOKEN}`, Origin: `http://${MM}`, "Sec-Fetch-Site": "same-origin" } });
    check(r.status === 200, "制御API: Tailscale 相当（mac-mini）・Cookie ありは 200", String(r.status));
    r = await httpReq({ addr: ext, host: MM, path: "/login", headers: { Accept: "text/html" } });
    check(r.status === 200, "UI: Tailscale 相当（mac-mini）から /login は開ける", String(r.status));
    w = await tryWs({ addr: ext, host: MM, headers: { Origin: `http://${MM}`, Cookie: `ebi_auth=${TOKEN}` } });
    check(w.open, "WS: Tailscale 相当（mac-mini）・Cookie ありは通る", JSON.stringify(w));
    w = await tryWs({ addr: ext, host: MM, headers: { Origin: `http://${MM}` } });
    check(!w.open && w.status === 401, "WS: Tailscale 相当（mac-mini）・トークン無しは 401", JSON.stringify(w));
  }

  // ---- (4) statusLine の報告と ebi-control MCP ----
  // ~/.claude/statusline-command.sh と同じ形（curl で 127.0.0.1 へ POST）。
  const code = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "5", "-X", "POST",
    "-H", "Content-Type: application/json", "--data", "{}", `${BASE}/control/usage`]).toString();
  check(code !== "401" && code !== "403", "statusLine の報告（curl → 127.0.0.1/control/usage）は認証で弾かれない", code);
  mcp = new Client({ name: "e2e-dns-rebind", version: "0.1.0" }, { capabilities: {} });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", join(ROOT, "src/mcp/control-server.ts")],
      cwd: ROOT,
      env: { ...process.env, EBI_CONTROL_URL: BASE, EBI_MCP_ROLE: "master", EBI_ID: "master", EBI_NOTIFY_SUBSCRIBE: "off" },
    }),
  );
  const listed = await mcp.callTool({ name: "list_ebi", arguments: {} });
  const text = (listed.content ?? []).map((c) => c.text ?? "").join("");
  check(!listed.isError && !/unauthorized|401/i.test(text), "ebi-control MCP（127.0.0.1）の list_ebi が通る", text.slice(0, 200));
} catch (err) {
  fail(`例外: ${err?.stack ?? err}`);
} finally {
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
