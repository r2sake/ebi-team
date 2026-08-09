// viewer 永続化（viewers.json）の live E2E。実サーバを別ポートで起動し、
// 「open → kill → 再起動 → 復元」を実機で確認する（実課金なし）。
//
// シナリオ:
//   P1. サーバ起動 → WS 接続直後の viewers は空。
//   P2. POST /control/open-viewer × 2 → viewers に 2 件 + viewers.json に 2 件保存される。
//   P3. サーバを kill → 再起動 → WS 接続直後の viewers に同じ id/title で 2 件復元されている。
//   P4. WS closeViewer で 1 件閉じる → viewers.json も 1 件に減る。
//   P5. 残り 1 件の実ファイルを削除 → 再起動 → warn skip され viewers は空・viewers.json も掃除済み。
//
// 隔離: 専用ポート・EBI_COMMAND=bash・EBI_VIEWER_ROOTS/EBI_VIEWERS_PATH/EBI_DUMP_PATH は temp。
//       稼働中の 8787（本番）や master/minaebi セッションには一切触らない。
//
// 実行: node scripts/e2e-viewer-persist.mjs

import { spawn } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const PORT = 8805;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const ok = (m) => { results.push(true); console.log("  OK:", m); };
const fail = (m) => { results.push(false); console.error("  NG:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpDir = mkdtempSync(join(tmpdir(), "ebi-e2e-vpersist-"));
const rootDir = join(tmpDir, "roots");
mkdirSync(rootDir, { recursive: true });
const storePath = join(tmpDir, ".ebi-team", "viewers.json");

const mdA = join(rootDir, "a.md");
const mdB = join(rootDir, "b.md");
writeFileSync(mdA, "# A\n\nこれは A。\n", "utf8");
writeFileSync(mdB, "# B\n\nこれは B。\n", "utf8");

let server = null;
let ws = null;
let received = []; // 受信した viewers メッセージ

function startServer() {
  server = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      EBI_PORT: String(PORT),
      EBI_COMMAND: "bash",
      EBI_DUMP_PATH: join(tmpDir, "registry.json"),
      EBI_VIEWERS_PATH: storePath,
      EBI_VIEWER_ROOTS: rootDir,
      EBI_IDLE_NOTIFY: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
  server.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));
}

async function waitHealthy(timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/control/agents`);
      if (res.ok) return true;
    } catch { /* 起動待ち */ }
    await sleep(200);
  }
  throw new Error("サーバが起動しませんでした");
}

function connectWs() {
  received = [];
  return new Promise((resolveWs, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "viewers") received.push(msg.viewers);
    });
    ws.on("open", () => resolveWs());
    ws.on("error", reject);
  });
}

async function stopAll() {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  if (server) {
    const p = server;
    server = null;
    await new Promise((r) => { p.once("exit", r); p.kill("SIGTERM"); setTimeout(() => { p.kill("SIGKILL"); r(); }, 4000); });
  }
}

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const readStore = () => (existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : null);
const last = () => received[received.length - 1] ?? [];

try {
  // ---- P1: 初回起動 ----
  console.log("\n[P1] 初回起動 → viewers は空");
  startServer();
  await waitHealthy();
  await connectWs();
  await sleep(300);
  last().length === 0 ? ok("接続直後の viewers が空") : fail(`viewers が空でない: ${JSON.stringify(last())}`);

  // ---- P2: open × 2 ----
  console.log("\n[P2] open × 2 → viewers.json に保存");
  const o1 = await postJson("/control/open-viewer", { path: mdA, title: "計画A" });
  const o2 = await postJson("/control/open-viewer", { path: mdB });
  o1.status === 200 && o2.status === 200 ? ok("open-viewer 2件が 200") : fail(`open 失敗: ${o1.status}/${o2.status}`);
  await sleep(400);
  last().length === 2 ? ok("broadcast の viewers が 2件") : fail(`viewers が2件でない: ${last().length}`);

  const store1 = readStore();
  const ids1 = (store1?.viewers ?? []).map((v) => v.id);
  ids1.length === 2 ? ok(`viewers.json に 2件保存 (${ids1.join(", ")})`) : fail(`viewers.json が不正: ${JSON.stringify(store1)}`);
  const hasFields = (store1?.viewers ?? []).every(
    (v) => typeof v.id === "string" && typeof v.path === "string" && typeof v.title === "string" && typeof v.openedAt === "number",
  );
  hasFields ? ok("各エントリに id/path/title/openedAt がある") : fail("必須フィールド欠落");
  (store1?.viewers ?? []).every((v) => v.content === undefined)
    ? ok("content は保存されていない（復元時に読み直し）") : fail("content が保存されている");
  const titles1 = (store1?.viewers ?? []).map((v) => v.title);
  JSON.stringify(titles1) === JSON.stringify(["計画A", "b.md"]) ? ok("title が保存されている") : fail(`title 不一致: ${titles1}`);

  // ---- P3: kill → 再起動 → 復元 ----
  console.log("\n[P3] kill → 再起動 → 復元");
  await stopAll();
  startServer();
  await waitHealthy();
  await connectWs();
  await sleep(400);
  const restored = last();
  restored.length === 2 ? ok("再起動後の viewers が 2件") : fail(`復元件数が違う: ${restored.length}`);
  JSON.stringify(restored.map((v) => v.id)) === JSON.stringify(ids1)
    ? ok(`id が再起動前と同一 (${ids1.join(", ")})`) : fail(`id 不一致: ${restored.map((v) => v.id)}`);
  JSON.stringify(restored.map((v) => v.title)) === JSON.stringify(["計画A", "b.md"])
    ? ok("title が再起動前と同一") : fail(`title 不一致: ${restored.map((v) => v.title)}`);
  restored[0]?.content?.includes("これは A。") && restored[0]?.format === "md"
    ? ok("content/format がファイルから読み直されている") : fail("content/format が不正");

  // ---- P4: close → viewers.json からも消える ----
  console.log("\n[P4] closeViewer → viewers.json から削除");
  ws.send(JSON.stringify({ type: "closeViewer", id: restored[0].id }));
  await sleep(500);
  last().length === 1 ? ok("broadcast の viewers が 1件") : fail(`close 後の件数が違う: ${last().length}`);
  const store2 = readStore();
  JSON.stringify((store2?.viewers ?? []).map((v) => v.id)) === JSON.stringify([restored[1].id])
    ? ok("viewers.json も 1件に減った") : fail(`viewers.json 不一致: ${JSON.stringify(store2?.viewers)}`);

  // ---- P5: ファイル欠損 → 再起動で skip + 掃除 ----
  console.log("\n[P5] 実ファイル削除 → 再起動で skip + 掃除（fail-soft）");
  await stopAll();
  rmSync(mdB);
  startServer();
  await waitHealthy();
  await connectWs();
  await sleep(400);
  last().length === 0 ? ok("欠損エントリは復元されない（viewers 空）") : fail(`skip されていない: ${JSON.stringify(last())}`);
  const store3 = readStore();
  (store3?.viewers ?? []).length === 0 ? ok("viewers.json も掃除された") : fail(`掃除されていない: ${JSON.stringify(store3?.viewers)}`);
  ok("サーバは起動を継続した（fail-soft）");
} catch (err) {
  fail(`例外: ${err?.stack || err}`);
} finally {
  await stopAll();
  rmSync(tmpDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n===== viewer 永続化 E2E: ${passed}/${results.length} PASS =====`);
process.exit(passed === results.length ? 0 : 1);
