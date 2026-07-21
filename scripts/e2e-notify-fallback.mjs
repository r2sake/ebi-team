// notification 配送信頼性（到達確認・PTY フォールバック・pending 可視化）の live runtime e2e。
//
// 2026-07-20 のインシデント（master 宛が「delivered と報告されるのに実際は届かない」）を
// 別ポートの isolated な実サーバ（実 HTTP・実 Registry/Mailbox・実 PTY エージェント）で再現し、
// 修正が効いていることを実証する。実 claude は使わない（EBI_COMMAND=bash の cat エージェントで
// PTY 到達を scrollback で観測する）。「制御MCP ブリッジ」は本物の src/mcp/control-server.ts が
// やることを HTTP で忠実に模した fake bridge（subscribe long-poll → emit 相当 → /control/ack）で
// 代替する。これによりブリッジの生死・ACK の有無を試験側が正確に制御できる。
//
// 検証シナリオ:
//   A. 健全 notify: ブリッジが購読＋ACK を返す → /control/inject が via:"notify"（到達確認済み）
//   B. 【インシデント本丸】ブリッジ死亡: 一度購読後に停止し liveness window 経過
//      → 旧実装は everSubscribed=true のため黙って mailbox に push し delivered（実際は消失）。
//        新実装は「今 live でない」を検知し PTY 注入へフォールバック（via:"pty"）＝実際に届く。
//   C. ブリッジ生存だが ACK 無し（harness が honor しない状況の相似形）:
//      → ACK タイムアウトで PTY フォールバック（via:"pty-fallback"）＝実際に届く。
//   D. 可視化: /control/pending・/control/ack エンドポイントが動作する。
//
// 安全策: 本番(8787)不可侵。専用ポート 8804 + mkdtemp。spawn した全プロセスを後始末する。

import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PORT = 8804;
const BASE = `http://127.0.0.1:${PORT}`;

// liveness window / ACK タイムアウトを短くしてテストを高速化する。
const LIVENESS_WINDOW_MS = 1500;
const ACK_TIMEOUT_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (m) => { results.push(true); console.log("  OK:", m); };
const fail = (m) => { results.push(false); console.error("  NG:", m); };

function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "");
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function scrollback(id) {
  const r = await get(`/control/scrollback?id=${id}`);
  return stripAnsi(r.body?.data ?? "");
}
async function waitForText(id, needle, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const txt = await scrollback(id);
    if (txt.includes(needle)) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await sleep(200);
  }
}

/**
 * fake bridge: 本物の control-server.ts subscribeLoop の HTTP 振る舞いを模す。
 * ack=true なら受信メッセージを /control/ack で確認する（健全ブリッジ）。
 * ack=false なら購読は続けるが ack を返さない（生きているが転送できない状況）。
 * stop() で購読ループを止める（ブリッジ死亡を模す）。
 */
function fakeBridge(id, { ack }) {
  let running = true;
  const received = [];
  const loop = (async () => {
    while (running) {
      try {
        const res = await fetch(`${BASE}/control/subscribe?id=${id}&timeoutMs=1000`, {
          signal: AbortSignal.timeout(3000),
        });
        const data = await res.json().catch(() => ({}));
        const msgs = data.messages ?? [];
        for (const m of msgs) received.push(m);
        if (ack && msgs.length > 0) {
          await post("/control/ack", { id, ids: msgs.map((m) => m.id) });
        }
      } catch {
        if (running) await sleep(100);
      }
    }
  })();
  return {
    received,
    async stop() {
      running = false;
      await loop.catch(() => {});
    },
  };
}

let server;
async function startServer(tmpDir) {
  const cwdDir = join(tmpDir, "cwd");
  mkdirSync(cwdDir, { recursive: true });
  writeFileSync(join(tmpDir, "no-fixed-ebi.json"), "{}\n"); // 固定エビ無し
  server = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      EBI_PORT: String(PORT),
      EBI_HOST: "127.0.0.1",
      EBI_COMMAND: "bash",
      EBI_ARGS: "-c cat", // PTY で入力を echo する軽量エージェント
      EBI_DEFAULT_CWD: cwdDir,
      EBI_DUMP_PATH: join(tmpDir, "registry.json"),
      EBI_CONFIG_PATH: join(tmpDir, "no-fixed-ebi.json"),
      EBI_IDLE_NOTIFY: "off",
      EBI_LIVENESS_WINDOW_MS: String(LIVENESS_WINDOW_MS),
      EBI_DELIVER_ACK_TIMEOUT_MS: String(ACK_TIMEOUT_MS),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  server.stderr.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  // listen まで待つ。
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try {
      const r = await get("/control/agents");
      if (r.status === 200) return;
    } catch {}
    await sleep(300);
  }
  throw new Error("サーバが起動しませんでした");
}

async function spawnBashAgent() {
  const r = await post("/control/spawn", { role: "engineer", kind: "dynamic" });
  if (r.status !== 200 || !r.body?.id) throw new Error("spawn 失敗: " + JSON.stringify(r));
  return r.body.id;
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "ebi-notify-fb-"));
  console.log("tmpDir:", tmpDir, "port:", PORT);
  await startServer(tmpDir);

  try {
    // ===== A. 健全 notify（購読＋ACK）=====
    console.log("\n--- A. 健全ブリッジ: notify 到達確認 ---");
    const idA = await spawnBashAgent();
    const bridgeA = fakeBridge(idA, { ack: true });
    await sleep(300); // 初回購読が張られるのを待つ（live 化）
    const rA = await post("/control/inject", { to: idA, from: "master", message: "NOTIFY_OK" });
    const dA = rA.body?.details?.[0];
    if (rA.status === 200 && dA?.via === "notify" && dA?.confirmed) ok(`A: via=notify・confirmed（${JSON.stringify(dA)}）`);
    else fail("A: notify 到達確認にならない: " + JSON.stringify(rA.body));
    await sleep(200);
    if (bridgeA.received.some((m) => m.message === "NOTIFY_OK")) ok("A: ブリッジが本文を受信した");
    else fail("A: ブリッジが受信していない: " + JSON.stringify(bridgeA.received));
    const sbA = await scrollback(idA);
    if (!sbA.includes("NOTIFY_OK")) ok("A: notify 経路なので PTY(scrollback)には出ない（二重配送していない）");
    else fail("A: PTY にも出てしまった（二重配送）");
    await bridgeA.stop();

    // ===== B. インシデント本丸: ブリッジ死亡 → PTY フォールバック =====
    console.log("\n--- B. ブリッジ死亡（everSubscribed だが今は dead）→ PTY フォールバック ---");
    const idB = await spawnBashAgent();
    const bridgeB = fakeBridge(idB, { ack: true });
    await sleep(300); // 一度購読を確立（everSubscribed=true）
    await bridgeB.stop(); // ブリッジ死亡
    await sleep(LIVENESS_WINDOW_MS + 300); // liveness window 経過 → dead 判定
    const rB = await post("/control/inject", { to: idB, from: "master", message: "AFTER_DEATH_MSG" });
    const dB = rB.body?.details?.[0];
    if (rB.status === 200 && dB?.via === "pty") ok(`B: dead 検知で PTY へフォールバック（${JSON.stringify(dB)}）`);
    else fail("B: PTY フォールバックしていない（旧実装なら消失）: " + JSON.stringify(rB.body));
    if (await waitForText(idB, "AFTER_DEATH_MSG", 5000)) ok("B: メッセージが実際にセッション(PTY)へ到達＝黙って消えていない");
    else fail("B: メッセージがセッションに届かなかった（=インシデント再現。修正が効いていない）");

    // ===== C. ブリッジ生存だが ACK 無し → PTY フォールバック =====
    console.log("\n--- C. 生存だが ACK 無し（honor されない相似形）→ PTY フォールバック ---");
    const idC = await spawnBashAgent();
    const bridgeC = fakeBridge(idC, { ack: false }); // 購読は続けるが ack しない
    await sleep(300);
    const rC = await post("/control/inject", { to: idC, from: "master", message: "NO_ACK_MSG" });
    const dC = rC.body?.details?.[0];
    if (rC.status === 200 && dC?.via === "pty-fallback") ok(`C: ACK タイムアウトで PTY フォールバック（${JSON.stringify(dC)}）`);
    else fail("C: pty-fallback にならない: " + JSON.stringify(rC.body));
    if (await waitForText(idC, "NO_ACK_MSG", 5000)) ok("C: メッセージが実際にセッション(PTY)へ到達");
    else fail("C: メッセージがセッションに届かなかった");
    const pend = await get("/control/pending");
    const cPending = (pend.body?.pending ?? []).find((p) => p.id === idC);
    if (!cPending || cPending.count === 0) ok("C: フォールバック後 pending は空（二重配送しない・回収済み）");
    else fail("C: pending が残っている: " + JSON.stringify(cPending));
    await bridgeC.stop();

    // ===== D. 可視化/ACK エンドポイント =====
    console.log("\n--- D. /control/pending・/control/ack エンドポイント ---");
    const pAll = await get("/control/pending");
    if (pAll.status === 200 && Array.isArray(pAll.body?.pending)) ok("D: /control/pending が配列を返す");
    else fail("D: /control/pending 応答不正: " + JSON.stringify(pAll.body));
    const ackR = await post("/control/ack", { id: "whoever", ids: [1, 2] });
    if (ackR.status === 200 && ackR.body?.ok) ok("D: /control/ack が受理される");
    else fail("D: /control/ack 応答不正: " + JSON.stringify(ackR.body));
  } finally {
    if (server) server.kill("SIGTERM");
    await sleep(800);
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const okCount = results.filter(Boolean).length;
  console.log(`\n==== notify fallback live e2e: ${okCount}/${results.length} OK ====`);
  process.exit(okCount === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("例外:", e?.stack ?? e);
  if (server) server.kill("SIGTERM");
  process.exit(1);
});
