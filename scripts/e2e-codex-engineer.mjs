// Codex バックエンド（PR-D）の live e2e。実 codex CLI を spawn して
// 「spawn → ready → 役割プロンプト注入 → タスク注入 → reply_to_master 着弾 → idle → kill 後に残存 0」
// を **連続 N 回（既定 10）** 計測する。
//
// 安全策（厳守事項の機械的担保）:
//   - **稼働サーバ（8787）に依存しない／触らない**。専用ポート（既定 8809）で control-server を
//     自前起動し、mkdtemp した状態ディレクトリで完結する。稼働 clone の dist / ebi-team.config.json /
//     master-mcp は読みも書きもしない（この worktree 内のソースだけを使う）。
//   - master は **bash の使い捨てエビ**（`echo MASTER_UP; exec cat`）。稼働 master へは何も送らない。
//   - 消費するのは ChatGPT サブスク枠。**極小プロンプト**（1 往復・PONG トークンを返すだけ）に絞る。
//   - 各ラウンドの終わりに kill し、最後に `pgrep -x codex` と ebi-control の残存を数えて報告する。
//
// 使い方:
//   npm run e2e:codex                       # 10 ラウンド
//   EBI_E2E_ROUNDS=3 npm run e2e:codex      # 回数を変える
//   EBI_E2E_PORT=8810 npm run e2e:codex     # ポートを変える

import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PORT = Number(process.env.EBI_E2E_PORT ?? 8809);
const BASE = `http://127.0.0.1:${PORT}`;
const ROUNDS = Number(process.env.EBI_E2E_ROUNDS ?? 10);
/** 1 ラウンドで reply 着弾を待つ上限（spawn は別途 ready 待ちがある）。 */
const ROUND_TIMEOUT_MS = Number(process.env.EBI_E2E_ROUND_TIMEOUT_MS ?? 180000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 開始時点で動いていた control-server の本数（母艦の稼働環境ぶん）。 */
let BASE_CONTROL_SERVERS = 0;

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
  async agents() {
    return (await this.get("/control/agents")).body?.agents ?? [];
  },
};

/**
 * 使い捨て config。
 * - master は bash（受信の可視化だけに使う。稼働 master には一切触らない）。
 * - 役割 "codexbot" は **読み取り寄り**（permissionMode=default → codex は -s read-only）。
 *   役割プロンプトは codex では起動引数に載らず、ready 後の初回 PTY 注入で届く（PR-D）。
 */
function writeConfig(dir) {
  const p = join(dir, "config.e2e.json");
  writeFileSync(
    p,
    JSON.stringify(
      {
        fixedEbi: [
          {
            id: "master",
            kind: "master",
            cwd: ROOT,
            command: "bash",
            args: ["-c", "echo MASTER_UP; exec cat"],
            notifySubscribe: false,
          },
        ],
        roles: {
          codexbot: {
            label: "codex 疎通係",
            emoji: "🟢",
            permissionMode: "default",
            // 本番の engineer 役割と同じく「報告は必ず reply_to_master ツールで」を明示する。
            // これが弱いと、エビはトークンをチャットに書いて終わり master に届かない
            // （codex + gpt-5.6-terra で実測。ツールの有無ではなく指示の強さの問題）。
            // 「ファイル編集・コマンド実行は一切しない」のような**全面禁止の言い回しは入れない**。
            // gpt-5.6-terra はこれを「ツール呼び出しも禁止／この環境にツールは無い」と解釈し、
            // 「reply_to_master ツールが利用できません」と答えて終わる（PR-D で実測）。
            appendSystemPrompt:
              "あなたはテスト用の疎通係。master への報告は必ず reply_to_master ツールで送ること" +
              "（チャットに書くだけでは master に届かない）。",
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
 * control-server の起動形。
 * 既定は **本番と同じ dist 起動**（`node dist/server/server/index.js`）。理由は制御MCP の
 * 起動コストで、dev 起動（tsx）だと ebi-control が `npx tsx` で立ち上がり、codex 側の
 * MCP 起動待ちに間に合わずツールが使えないことがある（PR-D 実測）。
 * EBI_E2E_SERVER_MODE=src で従来どおり src(tsx) 起動に切り替えられる（要 npm run build 済み）。
 */
function startServer(tmpDir, configPath) {
  const useSrc = process.env.EBI_E2E_SERVER_MODE === "src";
  const serverArgs = useSrc
    ? ["--import", "tsx", "src/server/index.ts"]
    : ["dist/server/server/index.js"];
  const proc = spawn("node", serverArgs, {
    cwd: ROOT,
    env: {
      ...process.env,
      EBI_PORT: String(PORT),
      EBI_HOST: "127.0.0.1",
      EBI_DEFAULT_CWD: ROOT,
      EBI_DUMP_PATH: join(tmpDir, "registry.json"),
      EBI_CONFIG_PATH: configPath,
      EBI_DELIVERY_LOG_PATH: join(tmpDir, "delivery.log"),
      EBI_FIXED_EBI_LOG_PATH: join(tmpDir, "fixed-ebi.log"),
      EBI_READY_WAIT_MS: "120000",
      EBI_SUBSCRIBE_WAIT_MS: "5000",
      EBI_IDLE_NOTIFY: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  return proc;
}

async function waitForServer(timeoutMs = 60000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await api.get("/control/agents");
      if (r.status === 200) return true;
    } catch {
      // まだ listen していない。
    }
    if (Date.now() - start > timeoutMs) return false;
    await sleep(500);
  }
}

/** master の scrollback に pattern が現れるまで待つ。 */
async function waitForMaster(pattern, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const txt = await api.scrollback("master");
    if (pattern.test(txt.replace(/\s+/g, ""))) return { found: true, txt };
    if (Date.now() - start >= timeoutMs) return { found: false, txt };
    await sleep(2000);
  }
}

/** 生きている codex プロセス数（このマシン全体）。 */
function codexProcCount() {
  try {
    const out = execFileSync("pgrep", ["-x", "codex"], { encoding: "utf8" }).trim();
    return out ? out.split("\n").length : 0;
  } catch {
    return 0; // pgrep は該当なしで exit 1。
  }
}

/** ebi-control（この e2e が立てた分）の残存プロセス数。 */
function controlServerCount() {
  try {
    const out = execFileSync("pgrep", ["-f", "mcp/control-server"], { encoding: "utf8" }).trim();
    return out ? out.split("\n").length : 0;
  } catch {
    return 0;
  }
}

/** 1 ラウンド: codex エビを spawn → 極小タスク → reply 着弾 → idle 確認 → kill → 残存確認。 */
async function runRound(i) {
  const token = `PONG${i}X${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const t0 = Date.now();
  const codexBefore = codexProcCount();

  // spawn（backend を明示指定。サーバ既定は claude のまま＝ロールバック経路を壊さない）。
  const sp = await api.post("/control/spawn", { role: "codexbot", backend: "codex", cwd: ROOT });
  if (sp.status !== 200 || !sp.body?.id) {
    return {
      i,
      ok: false,
      stage: "spawn",
      replied: false,
      idle: false,
      tail: `spawn 失敗 (${sp.status}): ${JSON.stringify(sp.body)}`,
      elapsedMs: Date.now() - t0,
    };
  }
  const id = sp.body.id;
  // /control/spawn は ready を待たずに返る（ready 前 exit の監視は非ブロッキング）。
  // 本文の配送側（sendMessage）が ready 到達まで待ってから PTY 注入するので、
  // ここでは待たずに送って本番と同じ経路を通す。
  const spawnMs = Date.now() - t0;

  // 極小タスク（ChatGPT 枠の消費を最小化）。先頭タグは厳守事項どおり [e2e-codex]。
  const message =
    `[e2e-codex] reply_to_master ツールを 1 回だけ呼び、message に ${token} とだけ入れて送ってください` +
    `（チャットに書くだけでは master に届きません）。`;
  const snd = await api.post("/control/send", { to: id, from: "master", message });
  const via = snd.body?.via ?? null;

  // 制御MCP（ebi-control）のプロセスが実際に立っているか（ツールが使えない失敗の切り分け用）。
  // ready 到達後に投げているので、この時点で立っていなければ codex が MCP を起動していない。
  await sleep(3000);
  const mcpDuringRound = controlServerCount() - BASE_CONTROL_SERVERS;

  // master（bash）の scrollback に `[from:<id>#n] [reply] <token>` が出れば着弾。
  const hit = await waitForMaster(new RegExp(token), ROUND_TIMEOUT_MS - (Date.now() - t0));
  const replyMs = Date.now() - t0;

  // idle へ戻ること（IdleDetector が codex の TUI で機能すること）を確認する。
  let idle = false;
  for (let k = 0; k < 20 && !idle; k++) {
    const agents = await api.agents();
    idle = agents.find((a) => a.id === id)?.status === "idle";
    if (!idle) await sleep(1000);
  }

  // 失敗時（または EBI_E2E_DUMP=1）は当該エビの画面末尾を残す（原因追跡用）。
  const full = !hit.found || process.env.EBI_E2E_DUMP === "1" ? await api.scrollback(id) : "";
  if (full) {
    // 起動フェーズごと残す（MCP 起動の様子は末尾だけでは見えない）。
    writeFileSync(`/tmp/e2e-codex-ebi-${i}.txt`, full);
  }
  const ebiTail = full.slice(-2500);

  await api.post("/control/kill", { id });
  // 次ラウンドまで少し空ける（前セッションの codex / 制御MCP の後始末が終わってから起動する）。
  await sleep(8000);
  const codexAfter = codexProcCount();

  return {
    i,
    id,
    token,
    ok: snd.status === 200 && hit.found && idle && codexAfter <= codexBefore,
    sendOk: snd.status === 200,
    via,
    replied: hit.found,
    mcpDuringRound,
    idle,
    codexBefore,
    codexAfter,
    spawnSec: Math.round(spawnMs / 100) / 10,
    replySec: Math.round(replyMs / 100) / 10,
    tail: hit.found ? "" : `master 末尾:\n${hit.txt.slice(-800)}\n--- エビ末尾:\n${ebiTail}`,
  };
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "ebi-codex-e2e-"));
  mkdirSync(tmpDir, { recursive: true });
  console.log(`tmpDir: ${tmpDir}  port: ${PORT}  rounds: ${ROUNDS}`);
  const baseControl = controlServerCount();
  BASE_CONTROL_SERVERS = baseControl;
  console.log(
    `開始時のプロセス: codex=${codexProcCount()} control-server=${baseControl}（稼働環境の分を含むベースライン）`,
  );

  const configPath = writeConfig(tmpDir);
  const srv = startServer(tmpDir, configPath);
  let results = [];
  try {
    if (!(await waitForServer())) throw new Error("control-server が起動しませんでした");
    await sleep(2000); // 固定エビ（master/bash）の起動待ち。

    for (let i = 1; i <= ROUNDS; i++) {
      const r = await runRound(i);
      results.push(r);
      console.log(
        `  [round ${r.i}] ok=${r.ok} replied=${r.replied} idle=${r.idle} via=${r.via} ` +
          `spawn=${r.spawnSec}s reply=${r.replySec}s mcp=${r.mcpDuringRound} ` +
          `codex=${r.codexBefore}->${r.codexAfter}`,
      );
      if (!r.ok && r.tail) console.log(`  --- master scrollback 末尾 ---\n${r.tail}\n  ---`);
    }
  } finally {
    // 後始末: 生き残りエビを全部落としてからサーバを止める。
    try {
      for (const a of await api.agents()) {
        if (a.id !== "master") await api.post("/control/kill", { id: a.id }).catch(() => {});
      }
    } catch {
      // サーバが既に死んでいる場合は無視。
    }
    srv.kill("SIGTERM");
    await sleep(2500);
    try {
      srv.kill("SIGKILL");
    } catch {
      // 既に終了済み。
    }
    await sleep(1500);
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== 結果: ${pass}/${ROUNDS} =====`);
  for (const r of results) {
    console.log(
      `  round ${r.i}: ok=${r.ok} replied=${r.replied} idle=${r.idle} ` +
        `spawn=${r.spawnSec}s reply=${r.replySec}s`,
    );
  }
  const codexLeft = codexProcCount();
  const controlLeft = controlServerCount();
  console.log(
    `終了後のプロセス: codex=${codexLeft}（0 が基準） control-server=${controlLeft}` +
      `（ベースライン ${baseControl} との差 ${controlLeft - baseControl} が 0 なら残存なし）`,
  );
  if (pass !== ROUNDS || codexLeft !== 0) {
    console.error("FAIL: 全ラウンド成功かつ codex 残存 0 が受け入れ基準です");
    process.exit(1);
  }
  console.log("PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
