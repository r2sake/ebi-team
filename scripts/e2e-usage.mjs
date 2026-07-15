// 使用状況ダッシュボード（タスク2）と @mention 廃止（タスク1）の E2E（実課金なし）。
// EBI_COMMAND=bash + 別ポートで一時サーバを立て、以下を確認する:
//
//  T1. WS `inject` ハンドラが無い/効かないこと（廃止）。
//      - 制御API /control/inject は従来どおり効くこと（残存）。
//  T2. POST /control/usage:
//      - サンプル statusLine JSON を curl 相当（fetch）で投げると WS `usage` に反映される
//      - 複数エビ分の集約・rate_limits（アカウント単位）の格納
//      - 未知 ebiId でも受理（緩く）
//      - X-Ebi-Id ヘッダ / ?ebiId= / body.ebiId の 3 経路
//  T3. EBI_ID が全 spawn 経路（master/supervisor/dynamic）の pty env に入ること
//      - bash エビを spawn し `env | grep EBI_ID` を実行 → scrollback で確認
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

// dev(8787) や他 e2e(8801-8803) と衝突しないポートを使う。
const PORT = 8810;
const BASE = `http://127.0.0.1:${PORT}`;

const tmpDir = mkdtempSync(join(tmpdir(), "ebi-e2e-usage-"));
const configPath = join(tmpDir, "ebi-team.config.json");
// 固定エビ（bash master/supervisor）。EBI_ID が固定エビ経路でも入ることを確認するため
// 起動時に env の EBI_ID を出力してから cat で生かす。
writeFileSync(
  configPath,
  JSON.stringify(
    {
      fixedEbi: [
        { id: "supervisor", kind: "supervisor", cwd: ".", model: "haiku", command: "bash", args: ["-c", 'echo "SUP_EBI_ID=$EBI_ID"; exec cat'] },
        { id: "master", kind: "master", cwd: root, model: "opus", command: "bash", args: ["-c", 'echo "MASTER_EBI_ID=$EBI_ID"; exec cat'] },
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

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function postJson(path, body, headers) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// サンプル statusLine JSON（実機確認済みスキーマ・課題文より）。
function sampleStatusLine(opts = {}) {
  return {
    session_id: "sess",
    cwd: root,
    model: { id: "claude-opus", display_name: opts.model ?? "Opus" },
    workspace: { current_dir: root, project_dir: root },
    cost: { total_cost_usd: opts.cost ?? 335.87, total_duration_ms: 1, total_api_duration_ms: 1, total_lines_added: 1, total_lines_removed: 1 },
    context_window: {
      total_input_tokens: 503305,
      total_output_tokens: 715,
      context_window_size: 1000000,
      current_usage: { input_tokens: 2, output_tokens: 715, cache_creation_input_tokens: 244, cache_read_input_tokens: 503059 },
      used_percentage: opts.ctxPct ?? 50,
      remaining_percentage: 50,
    },
    exceeds_200k_tokens: true,
    rate_limits: opts.rateLimits ?? {
      five_hour: { used_percentage: 32, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { used_percentage: 77, resets_at: Math.floor(Date.now() / 1000) + 86400 },
    },
  };
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
    EBI_IDLE_MS: "300",
    EBI_MIN_BOOT_MS: "300",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
server.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));

const overall = setTimeout(() => { fail("全体タイムアウト"); finish(); }, 40000);

async function finish() {
  clearTimeout(overall);
  const okCount = results.filter(Boolean).length;
  console.log(`\n==== usage/廃止 E2E 結果: ${okCount}/${results.length} OK ====`);
  await cleanup(okCount === results.length ? 0 : 1);
}

// WS に繋ぎ、受信した usage スナップショットを最新で保持する。
let latestUsage = null;
let wsErrorOnInject = false;
function connectWs() {
  return new Promise((resolveWs) => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on("open", () => resolveWs());
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "usage") latestUsage = msg;
      // 廃止された WS `inject` を送ると未知 type 扱いで error が返るはず。
      if (msg.type === "error" && /未知の message type/.test(msg.text ?? "")) {
        wsErrorOnInject = true;
      }
    });
    ws.on("error", () => {});
  });
}

async function main() {
  await sleep(3000); // サーバ起動＋固定エビ spawn 待ち
  await connectWs();
  await sleep(500); // 接続直後の初期スナップショット受信待ち

  // ===== T2. POST /control/usage → WS usage 反映 =====
  console.log("\n--- T2. POST /control/usage → WS usage ---");
  {
    // ヘッダ X-Ebi-Id 経路
    const r = await postJson("/control/usage", sampleStatusLine({ model: "Opus", cost: 100 }), { "X-Ebi-Id": "master" });
    if (r.status === 200 && r.body?.ok && r.body?.ebiId === "master") ok("POST /control/usage（X-Ebi-Id ヘッダ）");
    else fail("POST /control/usage（ヘッダ）失敗: " + JSON.stringify(r));
  }
  {
    // query ?ebiId= 経路（別エビ）
    const res = await fetch(`${BASE}/control/usage?ebiId=supervisor`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sampleStatusLine({ model: "Haiku", cost: 5 })),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 200 && body?.ebiId === "supervisor") ok("POST /control/usage（?ebiId= query）");
    else fail("POST /control/usage（query）失敗: " + JSON.stringify(body));
  }
  {
    // body.ebiId 経路 ＋ 未知 ebiId 受理
    const payload = { ...sampleStatusLine({ model: "Opus", cost: 50 }), ebiId: "unknown-xyz" };
    const r = await postJson("/control/usage", payload);
    if (r.status === 200 && r.body?.ebiId === "unknown-xyz") ok("POST /control/usage（body.ebiId・未知 id も受理）");
    else fail("POST /control/usage（body.ebiId）失敗: " + JSON.stringify(r));
  }

  await sleep(400); // broadcast 受信待ち
  {
    const u = latestUsage;
    const ids = (u?.agents ?? []).map((a) => a.id).sort();
    if (u && ids.includes("master") && ids.includes("supervisor") && ids.includes("unknown-xyz")) {
      ok(`WS usage に複数エビ集約（agents: ${ids.join(", ")}）`);
    } else {
      fail("WS usage の集約が不正: " + JSON.stringify(ids));
    }
  }
  {
    const u = latestUsage;
    const rl = u?.rateLimits;
    if (rl?.fiveHour?.usedPct === 32 && rl?.sevenDay?.usedPct === 77) {
      ok("WS usage に rate_limits（アカウント単位）格納");
    } else {
      fail("rate_limits 格納が不正: " + JSON.stringify(rl));
    }
  }
  {
    const u = latestUsage;
    // master(100) + supervisor(5) + unknown(50) = 155
    if (u && Math.abs((u.totalCostUsd ?? 0) - 155) < 0.001) ok(`totalCostUsd 合計（${u.totalCostUsd}）`);
    else fail("totalCostUsd が不正: " + JSON.stringify(u?.totalCostUsd));
  }
  {
    const u = latestUsage;
    const m = (u?.agents ?? []).find((a) => a.id === "master");
    if (m && m.model === "Opus" && m.contextUsedPct === 50 && m.tokens?.cacheRead === 503059) {
      ok("WS usage の cost/context/token 内訳が正しく展開");
    } else {
      fail("usage 内訳が不正: " + JSON.stringify(m));
    }
  }

  // ===== T1. WS inject 廃止 / 制御API inject 残存 =====
  console.log("\n--- T1. @mention 廃止（WS inject）/ 制御API inject 残存 ---");
  {
    // 廃止された WS `inject` を送る → サーバは「未知の message type」error を返すはず。
    wsErrorOnInject = false;
    ws.send(JSON.stringify({ type: "inject", to: "master", from: "user", message: "echo SHOULD_NOT_WORK" }));
    await sleep(600);
    if (wsErrorOnInject) ok("WS `inject` は廃止（未知 message type として拒否）");
    else fail("WS `inject` が拒否されなかった（ハンドラが残っている可能性）");
  }

  // 制御API inject は残存（master へ注入できる）。
  let dynId = null;
  {
    const r = await postJson("/control/spawn", { cwd: root });
    if (r.status === 200 && r.body?.id) { dynId = r.body.id; ok(`POST /control/spawn（dynamic 起動 id=${dynId}）`); }
    else fail("spawn 失敗: " + JSON.stringify(r));
  }
  if (dynId) {
    await sleep(1000);
    const r = await postJson("/control/inject", { to: dynId, message: "echo CTRL_INJECT_STILL_OK" });
    if (r.status === 200 && (r.body?.delivered ?? []).includes(dynId)) ok("POST /control/inject（残存・delivered）");
    else fail("制御API inject が失敗: " + JSON.stringify(r));
    await sleep(1000);
    const sb = await getJson(`/control/scrollback?id=${dynId}`);
    if ((sb.body?.data ?? "").includes("CTRL_INJECT_STILL_OK")) ok("制御API inject が scrollback に反映（残存）");
    else fail("制御API inject が反映されない");
  }

  // ===== T3. EBI_ID 全 spawn 経路（master/supervisor/dynamic）=====
  console.log("\n--- T3. EBI_ID 全 spawn 経路で pty env に注入 ---");
  {
    // 固定エビ（master/supervisor）は起動時に EBI_ID を echo 済み。
    const sbM = await getJson(`/control/scrollback?id=master`);
    if ((sbM.body?.data ?? "").includes("MASTER_EBI_ID=master")) ok("EBI_ID 注入（固定エビ master）");
    else fail("固定エビ master に EBI_ID が入っていない: " + JSON.stringify(sbM.body?.data?.slice?.(-120)));
    const sbS = await getJson(`/control/scrollback?id=supervisor`);
    if ((sbS.body?.data ?? "").includes("SUP_EBI_ID=supervisor")) ok("EBI_ID 注入（固定エビ supervisor）");
    else fail("固定エビ supervisor に EBI_ID が入っていない");
  }
  if (dynId) {
    // dynamic エビへ EBI_ID を出力させる。注入は `[from:master] <msg>` の形で届くため、
    // 先頭の `[from:master]` をコマンド扱いさせないよう `;` で文を区切ってから echo する。
    await postJson("/control/inject", { to: dynId, message: "; echo EBIID_IS=$EBI_ID" });
    await sleep(1000);
    const sb = await getJson(`/control/scrollback?id=${dynId}`);
    if ((sb.body?.data ?? "").includes(`EBIID_IS=${dynId}`)) ok(`EBI_ID 注入（dynamic ${dynId}）`);
    else fail("dynamic に EBI_ID が入っていない: " + JSON.stringify(sb.body?.data?.slice?.(-160)));
  }

  await finish();
}

main().catch(async (e) => { fail("例外: " + (e?.stack ?? e)); await finish(); });
