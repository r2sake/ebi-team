// spawnIfMissing 直後のタスク本文到達率を機械実測する live e2e（実 claude を spawn）。
//
// 背景（2026-07-25 指示書 §1）:
//   send_message(spawnIfMissing:true, message:<長文タスク>) で新規 spawn した際、タスク本文が
//   エビに届かず空プロンプトで放置される事象が頻発（既存セッションへの再送は 100% 成功）。
//   仮説の本丸は「到達確認がブリッジ到達（notification を stdout に書いた）止まりで、
//   セッション到達（harness が channel を honor してモデルに見せた）を確認していない」こと。
//   spawn 直後は claude 本体がまだ channel を登録し終えておらず、harness は notification を
//   黙って skip する。ACK は返るので deliver() は confirmed:true と誤判定し、PTY
//   フォールバックが発動しないまま本文が痕跡ゼロで消える。
//
// この e2e が測るもの:
//   ラウンド i ごとに使い捨てエビへ「長文＋一意トークン」を spawnIfMissing で送り、
//     - via / confirmed（/control/send の応答）
//     - echo   : 本文の一意トークンが scrollback に現れたか（＝セッションに届いた痕跡）
//     - acted  : モデルが指示どおり ACKOK<i> を出力したか（＝end-to-end 到達）
//   を集計し、到達率（acted ベース）を出す。受け入れ基準は 20/20（100%）。
//
// 使い方:
//   node scripts/e2e-spawn-delivery.mjs            # 既定 5 ラウンド・並列 2
//   EBI_E2E_ROUNDS=20 EBI_E2E_CONCURRENCY=4 node scripts/e2e-spawn-delivery.mjs
//
// 安全策: 本番(8787)不可侵。専用ポート 8801＋mkdtemp 状態ディレクトリで完結。
// spawn した claude は全て kill する。判定用エビは haiku 固定（安価・高速）。

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CWD_DIR = "/tmp/ebi-spawndel-e2e-cwd";
mkdirSync(CWD_DIR, { recursive: true });

const PORT = Number(process.env.EBI_E2E_PORT ?? 8801);
const BASE = `http://127.0.0.1:${PORT}`;
const ROUNDS = Number(process.env.EBI_E2E_ROUNDS ?? 5);
const CONCURRENCY = Number(process.env.EBI_E2E_CONCURRENCY ?? 2);
/** 1 ラウンドあたり ACKOK を待つ上限（起動〜モデル応答まで込み）。 */
const ROUND_TIMEOUT_MS = Number(process.env.EBI_E2E_ROUND_TIMEOUT_MS ?? 180000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gateLogs = [];

function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "");
}

const api = {
  async get(path) {
    const res = await fetch(`${BASE}${path}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  },
  async post(path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  },
  async scrollback(id) {
    const r = await this.get(`/control/scrollback?id=${encodeURIComponent(id)}`);
    return stripAnsi(r.body?.data ?? "");
  },
};

/**
 * 動的エビ（engineer ティア）用の制御MCP config。
 *
 * 既定は本番と同じ `node dist/...`（ビルド済み）。ここは再現性の肝で、`npx tsx` 起動だと
 * ブリッジ立ち上がりが 2〜3 秒遅く、その間にサーバの起動ゲート自動応答が dev-channels
 * ダイアログを越えてしまうため「購読確立が常にダイアログ突破の後」になり、本番で起きる
 * レース（ブリッジが先に購読 → セッションはまだダイアログ内 → notification が harness に
 * 黙って捨てられる）が再現しない。EBI_E2E_MCP_MODE=tsx で旧挙動に切り替え可。
 */
function writeMcpConfig(dir) {
  const p = join(dir, "engineer-control.e2e.mcp.json");
  const useTsx = process.env.EBI_E2E_MCP_MODE === "tsx";
  const server = useTsx
    ? { command: "npx", args: ["tsx", join(ROOT, "src/mcp/control-server.ts")] }
    : { command: "node", args: [join(ROOT, "dist/server/mcp/control-server.js")] };
  writeFileSync(
    p,
    JSON.stringify(
      {
        mcpServers: {
          "ebi-control": {
            ...server,
            cwd: ROOT,
            env: { EBI_CONTROL_URL: BASE, EBI_MCP_ROLE: "engineer" },
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  return p;
}

/**
 * 使い捨て config。固定エビ無し＋カスタム役割 "echobot"（haiku・エコー係）だけを持つ。
 * 本番の engineer 役割（重い prompt / opus）を使わず、到達判定だけを安く速く行う。
 */
function writeConfig(dir) {
  const p = join(dir, "config.e2e.json");
  writeFileSync(
    p,
    JSON.stringify(
      {
        roles: {
          echobot: {
            label: "エコー係",
            emoji: "🔁",
            defaultModel: "haiku",
            permissionMode: "bypassPermissions",
            appendSystemPrompt:
              "あなたはテスト用のエコー係。受け取ったメッセージ本文に「output only XXX」という指示が" +
              "含まれていたら、その XXX トークンだけを1行で返す。ツールは一切使わない。それ以外は何も書かない。",
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  return p;
}

function startServer(tmpDir, configPath, mcpConfig) {
  const proc = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      EBI_PORT: String(PORT),
      EBI_HOST: "127.0.0.1",
      EBI_DEFAULT_CWD: CWD_DIR,
      EBI_DUMP_PATH: join(tmpDir, "registry.json"),
      EBI_CONFIG_PATH: configPath,
      EBI_ENGINEER_MCP_CONFIG: mcpConfig,
      EBI_READY_WAIT_MS: "90000",
      EBI_SUBSCRIBE_WAIT_MS: "90000",
      EBI_IDLE_NOTIFY: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => {
    const s = String(d);
    if (/起動ゲート自動応答/.test(s)) {
      for (const line of s.split("\n")) if (line.includes("起動ゲート自動応答")) gateLogs.push(line.trim());
    }
    process.stdout.write(`[srv] ${s}`);
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  return proc;
}

/**
 * 本番のタスク指示書に近い長文本文を作る（消失事例はいずれも長文だったため長さを再現する）。
 * 末尾に「output only ACKOK<i>」を置き、モデルが本文末尾まで読めたことを判定できるようにする。
 */
function buildLongMessage(i, token) {
  const filler = [
    "## 背景",
    "この本文は spawn 直後のタスク本文到達率を測るための長文ダミーです。実運用のタスク指示書は" +
      "数千文字に及ぶことがあり、消失事例もすべて長文でした。長さそのものが条件に効くかを潰すため、" +
      "同等の分量を再現しています。",
    "## 前提",
    "- リポジトリはローカル運用（push 禁止）",
    "- サーバは dist を起動時ロードするため、修正の有効化には再起動が必要",
    "- 既存 unit テストと live e2e の回帰緑を維持すること",
    "## スコープ",
    "1. 実装経路の特定（spawn → ready 判定 → 初回送信）",
    "2. 再現テストの作成（実 claude を spawn して長文送信×N回・到達率を計測）",
    "3. 根治（到達確認をセッション到達へ格上げ / 未達なら自動リトライ）",
    "## 厳守ルール",
    "- git push 禁止 / git stash 禁止",
    "- 運用値の config を壊さない",
    "- 要件外の機能追加は禁止。気づきは実装せず提案として報告のみ",
  ].join("\n");
  return (
    `# タスク ${i}（到達計測用・トークン ${token}）\n\n` +
    filler +
    `\n\n---\n【最重要】この本文を最後まで読めたら、ツールを一切使わず、他には何も書かず ` +
    `output only ${token} とだけ1行で返してください。\n`
  );
}

/** 指定 id の scrollback に pattern が現れるまで待つ。 */
async function waitForText(id, pattern, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const txt = await api.scrollback(id);
    if (pattern.test(txt)) return { found: true, txt };
    if (Date.now() - start >= timeoutMs) return { found: false, txt };
    await sleep(2000);
  }
}

/** 1 ラウンド: 使い捨てエビへ spawnIfMissing で長文送信し、到達を判定する。 */
async function runRound(i) {
  const id = `ebi-sd-${i}`;
  const token = `ACKOK${i}X${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const message = buildLongMessage(i, token);
  const t0 = Date.now();
  const snd = await api.post("/control/send", {
    to: id,
    message,
    from: "master",
    spawnIfMissing: true,
    role: "echobot",
  });
  const via = snd.body?.details?.[0]?.via ?? snd.body?.via ?? null;
  const sendOk = snd.status === 200 && snd.body?.ok === true;
  // acted: モデルがトークンを出力した（end-to-end 到達）。
  const acted = await waitForText(id, new RegExp(token), ROUND_TIMEOUT_MS);
  const txt = acted.txt;
  // echo: 本文の痕跡（トークン以外の特徴語）が scrollback に見えるか。
  //   channel 受信なら "[from:master]" として、PTY 注入なら入力欄に本文が現れる。
  const echo = /from:master/.test(txt.replace(/\s+/g, "")) || new RegExp(`到達計測用`).test(txt);
  const elapsedMs = Date.now() - t0;
  return { i, id, token, sendOk, via, acted: acted.found, echo, elapsedMs, tail: txt.slice(-3000) };
}

/** 並列度 limit で全ラウンドを回す。 */
async function runAll() {
  const queue = Array.from({ length: ROUNDS }, (_, k) => k + 1);
  const out = [];
  const workers = Array.from({ length: Math.min(CONCURRENCY, ROUNDS) }, async () => {
    for (;;) {
      const i = queue.shift();
      if (i === undefined) return;
      const r = await runRound(i);
      out.push(r);
      console.log(
        `  [round ${r.i}] acted=${r.acted} echo=${r.echo} via=${r.via} ${Math.round(r.elapsedMs / 1000)}s`,
      );
      if (!r.acted || process.env.EBI_E2E_DUMP === "1") {
        console.log(`  --- round ${r.i} scrollback 末尾（acted=${r.acted}）---\n${r.tail}\n  ---`);
      }
      // 使い捨てエビは即 kill（同時起動数を抑える）。
      await api.post("/control/kill", { id: r.id }).catch(() => {});
      await sleep(500);
    }
  });
  await Promise.all(workers);
  return out.sort((a, b) => a.i - b.i);
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "ebi-spawndel-e2e-"));
  console.log(`tmpDir: ${tmpDir}  cwd: ${CWD_DIR}  rounds=${ROUNDS} concurrency=${CONCURRENCY}`);
  const mcpConfig = writeMcpConfig(tmpDir);
  const configPath = writeConfig(tmpDir);
  const srv = startServer(tmpDir, configPath, mcpConfig);
  let results = [];
  try {
    await sleep(2500);
    console.log(`\n--- spawnIfMissing × ${ROUNDS} ラウンド（長文本文の到達率計測）---`);
    results = await runAll();
  } finally {
    for (const r of results) await api.post("/control/kill", { id: r.id }).catch(() => {});
    srv.kill("SIGTERM");
    await sleep(1500);
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const acted = results.filter((r) => r.acted).length;
  const echoed = results.filter((r) => r.echo).length;
  const viaCount = {};
  for (const r of results) viaCount[r.via ?? "null"] = (viaCount[r.via ?? "null"] ?? 0) + 1;
  console.log("\n---- ラウンド内訳 ----");
  for (const r of results) {
    console.log(
      `  round ${String(r.i).padStart(2)}: acted=${r.acted ? "OK " : "NG "} echo=${r.echo ? "OK " : "NG "} via=${r.via} ${Math.round(r.elapsedMs / 1000)}s`,
    );
  }
  console.log(`  via 内訳: ${JSON.stringify(viaCount)}  起動ゲート自動応答: ${gateLogs.length} 回`);
  console.log(
    `\n==== spawnIfMissing 到達率: ${acted}/${results.length}（echo 痕跡 ${echoed}/${results.length}）====`,
  );
  process.exit(acted === results.length && results.length === ROUNDS ? 0 : 1);
}

main().catch((e) => {
  console.error("例外:", e?.stack ?? e);
  process.exit(1);
});
