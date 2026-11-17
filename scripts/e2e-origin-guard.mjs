// e2e: 別サイトのページからの WS / 制御API を弾く（CSWSH / CSRF 対策）。
//
// 確かめること:
//   (1) WS: 別サイトの Origin は拒否（403）・同一オリジンは通る・Origin の無い Node のクライアントは通る
//   (2) WS: Vite の開発サーバ経由（proxy）でも、同一オリジンは通り、別サイトの Origin は拒否される
//   (3) 制御API: 別サイトの Origin を付けた POST（text/plain の CSRF）は 403、Sec-Fetch-Site: cross-site の
//       GET（<img src> 相当）も 403、同一オリジンのブラウザ・Origin の無い Node の fetch は通る
//   (4) ebi-control MCP（Node の stdio ブリッジ）から制御API を叩ける
//
// 実行: npm run e2e:origin-guard
//  - 稼働中のサーバには触らない。専用ポート（既定 8817 / Vite 5187）で立て、自分が起動した PID だけ止める。
//  - 固定エビは起動しない（fixedEbi: []）。生成物は mkdtemp 配下。

import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PORT = Number(process.env.EBI_E2E_ORIGIN_PORT ?? 8817);
const VITE_PORT = Number(process.env.EBI_E2E_ORIGIN_VITE_PORT ?? 5187);
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (m) => { results.push(true); console.log("  OK:", m); };
const fail = (m) => { results.push(false); console.error("  NG:", m); };
const check = (cond, m, detail = "") => (cond ? ok(m) : fail(`${m} ${detail}`));

const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "ebi-e2e-origin-")));

function startServer() {
  const configPath = join(tmpDir, "config.json");
  writeFileSync(configPath, `${JSON.stringify({ fixedEbi: [] }, null, 2)}\n`);
  const proc = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      EBI_PORT: String(PORT),
      EBI_HOST: "127.0.0.1",
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
      EBI_AUTH_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  return proc;
}

/** WS を開いて、開けたら最初の registry を待つ。拒否されたら HTTP ステータスを返す。 */
function tryWs(url, headers) {
  return new Promise((res) => {
    const w = new WebSocket(url, { headers });
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

async function waitServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/control/agents`);
      if (r.ok) return;
    } catch { /* not yet */ }
    await sleep(200);
  }
  throw new Error("サーバが起動しない");
}

let srv = null;
let vite = null;
let mcp = null;
try {
  srv = startServer();
  await waitServer();

  // ---- (1) WS 直 ----
  const wsUrl = `ws://127.0.0.1:${PORT}/ws`;
  let r = await tryWs(wsUrl, { Origin: "https://evil.example" });
  check(!r.open && r.status === 403, "WS: 別サイトの Origin は 403 で拒否", JSON.stringify(r));
  r = await tryWs(wsUrl, { Origin: "http://localhost:3000" });
  check(!r.open && r.status === 403, "WS: 同じホストの別ポートの Origin も 403 で拒否", JSON.stringify(r));
  r = await tryWs(wsUrl, { Origin: "null" });
  check(!r.open && r.status === 403, "WS: Origin: null（sandbox iframe 等）は 403 で拒否", JSON.stringify(r));
  r = await tryWs(wsUrl, { Origin: BASE });
  check(r.open, "WS: 同一オリジンのブラウザは通る", JSON.stringify(r));
  r = await tryWs(wsUrl, {});
  check(r.open, "WS: Origin の無い Node のクライアントは通る（loopback）", JSON.stringify(r));

  // ---- (2) Vite の開発サーバ経由 ----
  vite = await createViteServer({
    configFile: false,
    root: join(ROOT, "src/client"),
    logLevel: "silent",
    server: {
      port: VITE_PORT,
      strictPort: true,
      host: "127.0.0.1",
      proxy: {
        "/ws": { target: `ws://localhost:${PORT}`, ws: true },
        "/control": { target: `http://localhost:${PORT}` },
      },
    },
  });
  await vite.listen();
  const viteOrigin = `http://127.0.0.1:${VITE_PORT}`;
  r = await tryWs(`ws://127.0.0.1:${VITE_PORT}/ws`, { Origin: viteOrigin });
  check(r.open, "WS（Vite proxy 経由）: 同一オリジンは通る", JSON.stringify(r));
  r = await tryWs(`ws://127.0.0.1:${VITE_PORT}/ws`, { Origin: "https://evil.example" });
  check(!r.open, "WS（Vite proxy 経由）: 別サイトの Origin は拒否", JSON.stringify(r));
  const viaVite = await fetch(`${viteOrigin}/control/agents`, { headers: { Origin: viteOrigin, "Sec-Fetch-Site": "same-origin" } });
  check(viaVite.status === 200, "制御API（Vite proxy 経由）: 同一オリジンは 200", String(viaVite.status));

  // ---- (3) 制御API ----
  // 別サイトのページからの「単純リクエスト」の POST（text/plain・preflight なし）＝ CSRF。
  let res = await fetch(`${BASE}/control/kill`, {
    method: "POST",
    headers: { Origin: "https://evil.example", "Content-Type": "text/plain", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ id: "nobody" }),
  });
  check(res.status === 403, "制御API: 別サイトの Origin の POST は 403", String(res.status));
  // <img src="http://127.0.0.1:8787/control/subscribe?id=master"> 相当（Origin なし・cross-site）。
  res = await fetch(`${BASE}/control/pending`, { headers: { "Sec-Fetch-Site": "cross-site" } });
  check(res.status === 403, "制御API: Sec-Fetch-Site: cross-site の GET（Origin なし）は 403", String(res.status));
  res = await fetch(`${BASE}/control/pending`, { headers: { "Sec-Fetch-Site": "same-site" } });
  check(res.status === 403, "制御API: Sec-Fetch-Site: same-site（localhost の別ポート）の GET も 403", String(res.status));
  res = await fetch(`${BASE}/control/agents`, { headers: { Origin: BASE, "Sec-Fetch-Site": "same-origin" } });
  check(res.status === 200, "制御API: 同一オリジンのブラウザは 200", String(res.status));
  res = await fetch(`${BASE}/control/agents`);
  check(res.status === 200, "制御API: Origin の無い Node の fetch は 200", String(res.status));
  // 制御API 以外（UI の静的配信）には掛けない（他サイトのリンクから UI を開けなくなるのを避ける）。
  res = await fetch(`${BASE}/`, { headers: { "Sec-Fetch-Site": "cross-site" } });
  check(res.status !== 403, "静的配信（/）は Origin 判定の対象外", String(res.status));

  // ---- (4) ebi-control MCP（Node の stdio ブリッジ）----
  mcp = new Client({ name: "e2e-origin-guard", version: "0.1.0" }, { capabilities: {} });
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
  check(!listed.isError && !/forbidden|403/i.test(text), "ebi-control MCP の list_ebi が通る", text.slice(0, 200));
} catch (err) {
  fail(`例外: ${err?.stack ?? err}`);
} finally {
  if (mcp) await mcp.close().catch(() => {});
  if (vite) await vite.close().catch(() => {});
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
