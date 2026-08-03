// 配送機構ハードニング（2026-08-04）の live runtime e2e。
//
// 幽霊 master 二重購読インシデント（tmp/delivery-investigation-2026-08-04.md）の恒久対策を、
// 別ポートの isolated な実サーバ（実 HTTP・実 Registry/Mailbox・実 PTY エージェント）で実証する。
// 実 claude は使わない（EBI_COMMAND=bash の cat エージェント）。ブリッジは本物の
// src/mcp/control-server.ts subscribeLoop の HTTP 振る舞いを模した fake bridge で代替し、
// 「同じ id を名乗る 2 本目」を試験側から任意に作れるようにする。
//
// 検証シナリオ:
//   A. 二重購読の拒否: 先着トークンが購読中に、別トークン（幽霊）が subscribe → 409。
//      配送は先着ブリッジにだけ届き、幽霊は 1 通も受け取らない（横取りゼロ）。
//   B. コネクション断で所有権が返る: 先着の long-poll を切ると、後着が失効待ちなしで座れる
//      （正規ブリッジの再起動が締め出されない）。
//   C. 恒久ログ: 二重購読・ACK タイムアウトが .ebi-team/delivery.log に JSONL で残る。
//   D. queued の区別: busy 中の宛先への PTY 注入は confirmed:false / queued:true になり、
//      idle 復帰後に実際にセッションへ flush される。
//
// 安全策: 本番(8787)不可侵。専用ポート 8805 + mkdtemp。spawn した全プロセスを後始末する。

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PORT = 8805;
const BASE = `http://127.0.0.1:${PORT}`;

const LIVENESS_WINDOW_MS = 3000;
const ACK_TIMEOUT_MS = 800;
// 所有権の失効時間。B では「失効を待たずに」座れることを見るため十分長くしておく。
const TAKEOVER_MS = 30000;

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
    if ((await scrollback(id)).includes(needle)) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await sleep(200);
  }
}

/**
 * fake bridge: 本物の subscribeLoop と同じく token 付きで long-poll し、受信を ack する。
 * status 409（二重購読の拒否）を受けたら rejected に記録して待機する。
 */
function fakeBridge(id, token) {
  let running = true;
  const received = [];
  const rejected = [];
  let controller = null;
  const loop = (async () => {
    while (running) {
      controller = new AbortController();
      try {
        const qs = `id=${id}&timeoutMs=1000&token=${encodeURIComponent(token)}`;
        const res = await fetch(`${BASE}/control/subscribe?${qs}`, { signal: controller.signal });
        if (res.status === 409) {
          rejected.push(await res.json().catch(() => ({})));
          await sleep(200); // 試験用に短く再試行（本物は 60s 待つ）
          continue;
        }
        const data = await res.json().catch(() => ({}));
        const msgs = data.messages ?? [];
        for (const m of msgs) received.push(m);
        if (msgs.length > 0) await post("/control/ack", { id, ids: msgs.map((m) => m.id) });
      } catch {
        if (running) await sleep(100);
      }
    }
  })();
  return {
    received,
    rejected,
    /** 購読ループを止める（プロセス消滅を模す。進行中の long-poll も切る）。 */
    async stop() {
      running = false;
      controller?.abort();
      await loop.catch(() => {});
    },
  };
}

let server;
let logPath;
async function startServer(tmpDir) {
  const cwdDir = join(tmpDir, "cwd");
  mkdirSync(cwdDir, { recursive: true });
  writeFileSync(join(tmpDir, "no-fixed-ebi.json"), "{}\n"); // 固定エビ無し
  logPath = join(tmpDir, "delivery.log");
  server = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      EBI_PORT: String(PORT),
      EBI_HOST: "127.0.0.1",
      EBI_COMMAND: "bash",
      EBI_ARGS: "-c cat",
      EBI_DEFAULT_CWD: cwdDir,
      EBI_DUMP_PATH: join(tmpDir, "registry.json"),
      EBI_CONFIG_PATH: join(tmpDir, "no-fixed-ebi.json"),
      EBI_DELIVERY_LOG_PATH: logPath,
      EBI_IDLE_NOTIFY: "off",
      EBI_IDLE_MS: "2500", // busy を観測しやすくする（D で使う）
      EBI_LIVENESS_WINDOW_MS: String(LIVENESS_WINDOW_MS),
      EBI_SUBSCRIBER_TAKEOVER_MS: String(TAKEOVER_MS),
      EBI_DELIVER_ACK_TIMEOUT_MS: String(ACK_TIMEOUT_MS),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  server.stderr.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try {
      if ((await get("/control/agents")).status === 200) return;
    } catch {}
    await sleep(300);
  }
  throw new Error("サーバが起動しませんでした");
}

function readLog() {
  if (!logPath || !existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

async function spawnBashAgent() {
  const r = await post("/control/spawn", { role: "engineer", kind: "dynamic" });
  if (r.status !== 200 || !r.body?.id) throw new Error("spawn 失敗: " + JSON.stringify(r));
  return r.body.id;
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "ebi-hardening-"));
  console.log("tmpDir:", tmpDir, "port:", PORT);
  await startServer(tmpDir);

  try {
    // ===== A. 二重購読の拒否（インシデント本丸）=====
    console.log("\n--- A. 同一 id を名乗る 2 本目（幽霊）を拒否する ---");
    const idA = await spawnBashAgent();
    const real = fakeBridge(idA, "real-1");
    await sleep(400); // 先着が購読を確立
    const ghost = fakeBridge(idA, "ghost-666");
    await sleep(600); // 幽霊が数回 subscribe を試みる

    if (ghost.rejected.length > 0) ok(`A: 幽霊の購読が 409 で拒否された（${ghost.rejected.length} 回）`);
    else fail("A: 幽霊が拒否されていない（旧実装なら席を奪って横取りする）");

    for (let i = 0; i < 5; i++) {
      await post("/control/inject", { to: idA, from: "master", message: `HARDENING_MSG_${i}` });
    }
    await sleep(400);
    if (real.received.length === 5) ok(`A: 5 通すべて先着ブリッジが受信（${real.received.length}/5）`);
    else fail(`A: 先着ブリッジの受信数が不正: ${real.received.length}/5`);
    if (ghost.received.length === 0) ok("A: 幽霊は 1 通も受け取っていない（横取りゼロ）");
    else fail(`A: 幽霊が横取りした: ${JSON.stringify(ghost.received)}`);
    await ghost.stop();

    // ===== B. コネクション断で所有権が返る =====
    console.log("\n--- B. 先着が消えたら（コネクション断）後着が失効待ちなしで座れる ---");
    await real.stop(); // long-poll を abort（プロセス消滅相当）
    await sleep(300);
    const restarted = fakeBridge(idA, "real-2");
    await sleep(600);
    if (restarted.rejected.length === 0) ok("B: 再起動ブリッジは拒否されず購読できた（締め出しなし）");
    else fail(`B: 再起動ブリッジが締め出された: ${JSON.stringify(restarted.rejected[0])}`);
    const rB = await post("/control/inject", { to: idA, from: "master", message: "AFTER_RESTART" });
    await sleep(400);
    if (restarted.received.some((m) => m.message === "AFTER_RESTART")) {
      ok(`B: 再起動後のブリッジへ配送できた（via=${rB.body?.details?.[0]?.via}）`);
    } else fail("B: 再起動後のブリッジへ配送できていない: " + JSON.stringify(rB.body));
    await restarted.stop();

    // ===== C. 恒久ログ =====
    console.log("\n--- C. 配送ログがファイルに残る（事後追跡できる）---");
    const idC = await spawnBashAgent();
    const silent = fakeBridge(idC, "no-ack"); // 購読はするが ack を返さない…
    // ack を返さないブリッジを作るため、ここでは購読だけ張って /control/ack を叩かない
    // 疑似ループを別途回す（fakeBridge は ack するので stop してから手動 long-poll）。
    await silent.stop();
    const noAckLoop = (async () => {
      const until = Date.now() + 4000;
      while (Date.now() < until) {
        await fetch(`${BASE}/control/subscribe?id=${idC}&timeoutMs=1000&token=no-ack`).catch(() => {});
      }
    })();
    await sleep(300);
    await post("/control/inject", { to: idC, from: "master", message: "LOGGED_FALLBACK" });
    await noAckLoop;

    const log = readLog();
    const dup = log.find((l) => l.event === "duplicate-subscriber");
    const ackTimeout = log.find((l) => l.event === "ack-timeout");
    if (dup) ok(`C: duplicate-subscriber がログに残る（id=${dup.id} holder=${dup.holder?.token}）`);
    else fail("C: duplicate-subscriber がログに無い: " + JSON.stringify(log.map((l) => l.event)));
    if (ackTimeout) ok(`C: ack-timeout がログに残る（id=${ackTimeout.id}）`);
    else fail("C: ack-timeout がログに無い: " + JSON.stringify(log.map((l) => l.event)));
    if (log.every((l) => typeof l.ts === "string" && Date.parse(l.ts) > 0)) ok("C: 各行に追跡可能な時刻がある");
    else fail("C: ts が不正な行がある");

    // ===== D. queued の区別 =====
    console.log("\n--- D. busy 滞留は confirmed:true と偽らず queued として返す ---");
    const idD = await spawnBashAgent();
    // 何か出力させて busy にする（cat のエコー。EBI_IDLE_MS=2500 の間 busy）。
    await post("/control/inject", { to: idD, from: "master", message: "WAKE" });
    await sleep(300);
    const rD = await post("/control/inject", { to: idD, from: "master", message: "QUEUED_MSG" });
    const dD = rD.body?.details?.[0];
    if (dD?.queued === true && dD?.confirmed === false) ok(`D: 滞留を queued として区別（${JSON.stringify(dD)}）`);
    else fail("D: queued の区別ができていない: " + JSON.stringify(rD.body));
    if (await waitForText(idD, "QUEUED_MSG", 8000)) ok("D: idle 復帰後に実際へ flush された（失われていない）");
    else fail("D: 滞留した本文がセッションへ届かなかった");
  } finally {
    if (server) server.kill("SIGTERM");
    await sleep(800);
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const okCount = results.filter(Boolean).length;
  console.log(`\n==== delivery hardening live e2e: ${okCount}/${results.length} OK ====`);
  process.exit(okCount === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("例外:", e?.stack ?? e);
  if (server) server.kill("SIGTERM");
  process.exit(1);
});
