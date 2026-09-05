// 固定エビ supervisor を gemini バックエンドに差し替えたときの live e2e（実 gemini 課金あり）。
//
// 検証するのは 2 点:
//   1. 常駐 supervisor（PTY）が backend=gemini で起動し ready に到達する
//      （config の fixedEbi[].backend / model だけで切り替わること・役割 GEMINI.md が書かれること）
//   2. ask_supervisor（master → 制御MCP → /control/summarize → ワンショット gemini）の往復が
//      成立し、日本語 3〜5 行の要約が master 側へ返ること（既定 5 ラウンド）
//
// 稼働サーバ(8787)には触らない（専用ポート 8805 ＋ mkdtemp の使い捨て状態ディレクトリ）。
// 終了時に gemini のプロセスグループ残存 0 を確認する。
//
//   node scripts/e2e-supervisor-gemini.mjs
//   EBI_E2E_ROUNDS=3 node scripts/e2e-supervisor-gemini.mjs

import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const PORT = 8805;
const BASE = `http://127.0.0.1:${PORT}`;
const ROUNDS = Number(process.env.EBI_E2E_ROUNDS ?? 5);
// Code Assist 経路で実際に使える Flash 系最新（supervisor.ts の GEMINI_SUMMARY_MODEL と同値）。
const MODEL = process.env.EBI_E2E_GEMINI_MODEL ?? "gemini-3.5-flash";

const SUPERVISOR_PROMPT =
  "あなたはエビチーム(ebi-team)の監督エビ。渡されたターミナルログを読み、" +
  "今何が起きているか/詰まっていないか/次アクションを日本語3〜5行で簡潔に要約する。それ以外の作業はしない。";

const tmpDir = mkdtempSync(join(tmpdir(), "ebi-e2e-supgem-"));
const workDir = join(tmpDir, "work");
const runtimeDir = join(tmpDir, "gemini-runtime");
execFileSync("mkdir", ["-p", workDir, runtimeDir]);

const configPath = join(tmpDir, "ebi-team.config.json");
writeFileSync(
  configPath,
  JSON.stringify(
    {
      fixedEbi: [
        {
          id: "supervisor",
          kind: "supervisor",
          cwd: workDir,
          backend: "gemini",
          model: MODEL,
          appendSystemPrompt: SUPERVISOR_PROMPT,
        },
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

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let server;
let mcpClient;
let mcpTransport;

// 常駐 supervisor（gemini）の pid。撤収時にプロセスグループ残存を数えるのに使う。
// 並行で走る他セッションの gemini を巻き込まないよう、pgid 基準で自分の分だけ見る。
let supervisorPid = null;

/** 自分が起動した gemini のプロセスグループ残存（pgid = PTY リーダの pid）。 */
function geminiSurvivors() {
  if (!supervisorPid) return [];
  try {
    const out = execFileSync("pgrep", ["-g", String(supervisorPid)], { encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function cleanup(code) {
  try { await mcpClient?.close(); } catch {}
  try { await mcpTransport?.close(); } catch {}
  try { server?.kill("SIGTERM"); } catch {}
  await sleep(3000);
  const left = geminiSurvivors();
  if (left.length === 0) {
    console.log(`  OK: 撤収後の gemini プロセスグループ残存 0（pgid=${supervisorPid ?? "-"}）`);
  } else {
    console.error(`  NG: gemini が残存: ${left.join(", ")}`);
    code = 1;
  }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

// ---- 一時サーバ起動（EBI_COMMAND=bash＝要約対象は安い bash エビ・別ポート）----
server = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    EBI_PORT: String(PORT),
    EBI_COMMAND: "bash",
    EBI_CONFIG_PATH: configPath,
    EBI_DUMP_PATH: join(tmpDir, "registry.json"),
    EBI_VIEWERS_PATH: join(tmpDir, "viewers.json"),
    EBI_GEMINI_RUNTIME_DIR: runtimeDir,
    EBI_IDLE_MS: "900",
    // 要約エンジンは実 gemini を叩く（スタブを差さない）。
    EBI_SUMMARY_CMD: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let srvLog = "";
server.stdout.on("data", (d) => { srvLog += d; process.stdout.write("[srv] " + d); });
server.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));

const overall = setTimeout(() => { fail("全体タイムアウト"); void finish(); }, 420_000);

async function finish() {
  clearTimeout(overall);
  const okCount = results.filter(Boolean).length;
  console.log(`\n==== supervisor=gemini live e2e: ${okCount}/${results.length} OK ====`);
  await cleanup(okCount === results.length ? 0 : 1);
}

/** 日本語（かな/漢字）を含むか。 */
const hasJapanese = (s) => /[぀-ヿ一-龯]/.test(s);

/** 箇条書き/改行で数えた行数（空行は除く）。 */
const lineCount = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean).length;

async function main() {
  await sleep(3000); // サーバ起動待ち

  // ===== 0. 起動ログ: 要約エンジンが gemini に切り替わっている =====
  if (/監督・要約: 有効（サブスク gemini CLI \/ .+ ワンショット要約）/.test(srvLog)) {
    ok(`起動ログ: 要約エンジン = gemini（${MODEL}）`);
  } else {
    fail("起動ログに gemini 要約エンジンが出ない: " + srvLog.slice(-500));
  }

  // ===== 1. 常駐 supervisor（PTY・backend=gemini）が ready になる =====
  {
    // gemini の ready 判定は入力欄の描画（backends/gemini.ts の readyPattern と同じ根拠）。
    let ready = false;
    let sawAgent = false;
    for (let i = 0; i < 60; i++) {
      const list = await fetch(`${BASE}/control/agents`).catch(() => null);
      const listBody = await list?.json().catch(() => null);
      const sup = (listBody?.agents ?? []).find((a) => a.id === "supervisor");
      if (sup) {
        sawAgent = true;
        supervisorPid = sup.pid ?? supervisorPid;
        if (sup.backend !== "gemini") { fail(`supervisor の backend が gemini でない: ${sup.backend}`); break; }
        const sb = await fetch(`${BASE}/control/scrollback?id=supervisor&tail=4000`).catch(() => null);
        const sbBody = await sb?.json().catch(() => null);
        if (/Type your message/.test(sbBody?.data ?? "")) { ready = true; break; }
      }
      await sleep(2000);
    }
    if (ready) ok("常駐 supervisor が backend=gemini で ready に到達（入力欄描画）");
    else fail(`常駐 supervisor が ready にならない（120s・agent 検出=${sawAgent}）`);

    const mdPath = join(runtimeDir, "supervisor", "GEMINI.md");
    if (existsSync(mdPath) && readFileSync(mdPath, "utf8").includes("監督エビ")) {
      ok("常駐 supervisor の役割プロンプトが per-エビ GEMINI.md に書かれている");
    } else {
      fail(`役割 GEMINI.md が無い/内容が違う: ${mdPath}`);
    }
  }

  // ===== 2. 要約対象の bash エビを立て、scrollback を貯める =====
  const sp = await postJson("/control/spawn", { cwd: workDir });
  const target = sp.body?.id;
  if (sp.status !== 200 || !target) { fail("要約対象エビの spawn 失敗: " + JSON.stringify(sp)); return finish(); }
  ok(`要約対象エビ ${target} を起動（bash）`);
  await sleep(1200);

  // ===== 3. ask_supervisor（制御MCP）を ROUNDS 回 =====
  mcpTransport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/control-server.ts"],
    cwd: root,
    env: { ...process.env, EBI_CONTROL_URL: BASE },
  });
  mcpClient = new Client({ name: "e2e-supgem-client", version: "0.0.1" });
  await mcpClient.connect(mcpTransport);

  const stats = [];
  for (let round = 1; round <= ROUNDS; round++) {
    // ラウンドごとに違うログを流す（同じ要約の使い回しを検出できるようにする）。
    await postJson("/control/inject", {
      to: target,
      message:
        `echo "[round ${round}] npm test を実行中"; ` +
        `echo "not ok ${round} - fixture ${round} failed: expected 'x' got undefined"; ` +
        `echo "git status: modified src/server/config.ts"`,
    });
    await sleep(1500);

    const t0 = Date.now();
    let text = "";
    let isError = true;
    try {
      const res = await mcpClient.callTool({
        name: "ask_supervisor",
        arguments: { target_id: target },
      });
      isError = Boolean(res.isError);
      text = res.content?.[0]?.text ?? "";
    } catch (e) {
      text = String(e?.message ?? e);
    }
    const sec = (Date.now() - t0) / 1000;
    // ツール結果の 1 行目は "<id> の要約:" というヘッダなので本文だけ見る。
    const body = text.split("\n").slice(1).join("\n").trim();
    const lines = lineCount(body);
    const jp = hasJapanese(body);
    const good = !isError && body.length > 0 && jp && lines >= 3 && lines <= 5;
    stats.push({ round, sec, lines, jp, good, body });
    console.log(
      `  [round ${round}] ${good ? "OK" : "NG"} ${sec.toFixed(1)}s / ${lines}行 / 日本語=${jp}`,
    );
    console.log("    " + body.replace(/\n/g, "\n    ").slice(0, 600));
  }

  const succeeded = stats.filter((s) => !!s.body && s.jp).length;
  const shaped = stats.filter((s) => s.good).length;
  const avg = stats.reduce((a, s) => a + s.sec, 0) / (stats.length || 1);
  console.log(
    `\n  --- ask_supervisor: 成功 ${succeeded}/${ROUNDS} / 3〜5行の日本語 ${shaped}/${ROUNDS}` +
      ` / 平均 ${avg.toFixed(1)}s ---`,
  );
  if (succeeded === ROUNDS) ok(`ask_supervisor 往復 ${ROUNDS}/${ROUNDS} 成功（日本語の要約が返る）`);
  else fail(`ask_supervisor 往復が ${succeeded}/${ROUNDS} しか成功しない`);
  if (shaped >= Math.ceil(ROUNDS * 0.8)) ok(`要約の体裁（3〜5行）${shaped}/${ROUNDS}`);
  else fail(`要約が 3〜5行に収まったのは ${shaped}/${ROUNDS} のみ`);

  await finish();
}

main().catch(async (e) => { fail("例外: " + (e?.stack ?? e)); await finish(); });
