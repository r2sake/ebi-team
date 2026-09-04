// Gemini バックエンド（PR-C）の live e2e。
//
// 測るもの（1 ラウンド = 使い捨て gemini エビ 1 匹）:
//   spawn → ready → タスク注入 → reply_to_master が master へ着弾 → idle 復帰 → kill 後に残存プロセス 0
// を **連続 N 回**（既定 10 回）繰り返し、全項目 100% を受け入れ基準とする。
//
// 安全策:
//   - 稼働サーバ(8787) 不可侵。専用ポート（既定 8803）＋ mkdtemp の使い捨て状態ディレクトリで完結。
//   - master は bash（`echo MASTER_UP; exec cat`）。reply_to_master は PTY 注入で master の
//     scrollback に現れるので、実 claude を 1 匹も起動せずに着弾を判定できる。
//   - per-エビ gemini settings は EBI_GEMINI_RUNTIME_DIR で tmp 配下へ隔離する
//     （`~/.gemini/settings.json` / `trustedFolders.json` には一切触らない）。
//   - 終了時に spawn した全エビを kill し、`pgrep -f "npm-global.*gemini"` が 0 件であることを検査する。
//
// 使い方:
//   node scripts/e2e-gemini-engineer.mjs                 # 10 ラウンド（直列）
//   EBI_E2E_ROUNDS=3 node scripts/e2e-gemini-engineer.mjs
//   EBI_E2E_INITIAL_PROMPT=1 node scripts/e2e-gemini-engineer.mjs   # `-i` 方式の参考計測も行う

import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PORT = Number(process.env.EBI_E2E_PORT ?? 8803);
const BASE = `http://127.0.0.1:${PORT}`;
const ROUNDS = Number(process.env.EBI_E2E_ROUNDS ?? 10);
/** 1 ラウンドの上限（gemini の起動 5〜7 秒＋往復 2〜4 秒＋MCP 立ち上げを見込む）。 */
const ROUND_TIMEOUT_MS = Number(process.env.EBI_E2E_ROUND_TIMEOUT_MS ?? 180000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  async list() {
    const r = await this.get("/control/agents");
    return r.body?.agents ?? [];
  },
};

/** 動的エビ（engineer ティア）用の制御MCP config（本番と同じ `node dist/...`）。 */
function writeMcpConfig(dir) {
  const p = join(dir, "engineer-control.e2e.mcp.json");
  writeFileSync(
    p,
    JSON.stringify(
      {
        mcpServers: {
          "ebi-control": {
            command: "node",
            args: [join(ROOT, "dist/server/mcp/control-server.js")],
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
 * 使い捨て config。master は bash（reply の着弾先）、役割は gemini 向けの極小 "scout"。
 * defaultModel は**あえて指定しない**（カスタム役割の既定 "sonnet" が入る）。gemini 側で
 * 非 gemini モデル名が既定モデルへ落ちること（resolveGeminiModel）を実機で通す。
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
            model: "opus",
            command: "bash",
            args: ["-c", "echo MASTER_UP; exec cat"],
          },
        ],
        roles: {
          scout: {
            label: "調査係",
            emoji: "🔎",
            permissionMode: "bypassPermissions",
            appendSystemPrompt:
              "あなたはエビチームの調査係エビ。指示に従い、結果は必ず reply_to_master ツールで master に送る。" +
              "ファイルの書き込み・破壊的操作・外部送信はしない。",
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
      EBI_DEFAULT_CWD: tmpDir,
      EBI_DUMP_PATH: join(tmpDir, "registry.json"),
      EBI_CONFIG_PATH: configPath,
      EBI_ENGINEER_MCP_CONFIG: mcpConfig,
      // per-エビ gemini settings / 役割 GEMINI.md の置き場（~/.gemini は不可侵）。
      EBI_GEMINI_RUNTIME_DIR: join(tmpDir, "gemini-runtime"),
      EBI_READY_WAIT_MS: "90000",
      EBI_SUBSCRIBE_WAIT_MS: "5000",
      EBI_IDLE_NOTIFY: "off",
      EBI_FIXED_EBI_LOG_PATH: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  return proc;
}

/** master(bash) の scrollback に pattern が現れるまで待つ。 */
async function waitForMaster(pattern, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const txt = await api.scrollback("master");
    if (pattern.test(txt)) return { found: true, txt };
    if (Date.now() - start >= timeoutMs) return { found: false, txt };
    await sleep(1500);
  }
}

/** 指定エビが idle になるまで待つ。 */
async function waitForIdle(id, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const agents = await api.list();
    const rec = agents.find((a) => a.id === id);
    if (!rec) return { idle: false, gone: true };
    if (rec.status === "idle") return { idle: true, gone: false, pid: rec.pid };
    if (Date.now() - start >= timeoutMs) return { idle: false, gone: false, pid: rec.pid };
    await sleep(1000);
  }
}

/** プロセスグループ配下の生存プロセス数（kill 後の孤児検査）。 */
function groupAlive(pid) {
  if (!pid) return 0;
  try {
    const out = execFileSync("pgrep", ["-g", String(pid)], { encoding: "utf8" }).trim();
    return out ? out.split("\n").filter(Boolean).length : 0;
  } catch {
    return 0; // pgrep はマッチ 0 件で exit 1
  }
}

/** 環境全体に残っている gemini プロセス数（PoC と同じ検査）。 */
function geminiProcessCount() {
  try {
    const out = execFileSync("bash", ["-lc", 'pgrep -f "npm-global.*gemini" | wc -l'], {
      encoding: "utf8",
    });
    return Number(out.trim());
  } catch {
    return -1;
  }
}

/** 1 ラウンド: gemini エビを spawn → 極小タスク注入 → reply 着弾 → idle → kill → 残存検査。 */
async function runRound(i) {
  const id = `ebi-gem-${i}`;
  const token = `GEMOK${i}X${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const message =
    `reply_to_master ツールを 1 回だけ呼び、message に ${token} とだけ入れて送ってください。` +
    `ファイルは読まない。他には何も書かない。`;
  const t0 = Date.now();

  // spawnIfMissing で spawn → ready 待ち → 注入まで一気通貫（本番と同じ経路）。
  const snd = await api.post("/control/send", {
    to: id,
    message,
    from: "master",
    spawnIfMissing: true,
    role: "scout",
    backend: "gemini",
    cwd: process.env.EBI_E2E_CWD ?? undefined,
  });
  const sendOk = snd.status === 200 && snd.body?.ok === true;
  const via = snd.body?.details?.[0]?.via ?? snd.body?.via ?? null;

  // reply_to_master が master(bash) に着弾したか。
  const hit = await waitForMaster(new RegExp(token), ROUND_TIMEOUT_MS);
  // 応答後に idle へ落ちるか（永久 busy にならないか）。
  const idle = hit.found ? await waitForIdle(id, 60000) : { idle: false };

  const agents = await api.list();
  const rec = agents.find((a) => a.id === id);
  const pid = rec?.pid ?? idle.pid ?? null;
  const backend = rec?.backend ?? null;
  const sb = await api.scrollback(id);
  // 役割 GEMINI.md が読み込まれているか（フッタの "N GEMINI.md files"）。
  const ctxFiles = /(\d+)\s*GEMINI\.md/i.exec(sb.replace(/\s+/g, " "));

  await api.post("/control/kill", { id });
  await sleep(3000);
  const leftover = groupAlive(pid);

  return {
    i,
    id,
    token,
    sendOk,
    via,
    backend,
    delivered: hit.found,
    idle: idle.idle === true,
    pid,
    leftover,
    geminiMd: ctxFiles ? Number(ctxFiles[1]) : null,
    elapsedMs: Date.now() - t0,
    tail: sb.slice(-2500),
  };
}

/**
 * 参考計測: 初回タスクを `-i` で渡す方式（PTY 注入方式との比較用）。
 * ebi-team の spawn API は「spawn → send_message」の 2 段でタスクが spawn 時点に無いため
 * 既定では使わないが、成立自体は確認しておく。
 */
async function measureInitialPrompt(runtimeDir) {
  const pty = await import("node-pty");
  const results = [];
  for (let k = 1; k <= 2; k++) {
    const token = `IPOK${k}`;
    const dir = join(runtimeDir, `ip-${k}`);
    mkdirSync(dir, { recursive: true });
    const settings = {
      ui: { useAlternateBuffer: false },
      security: { folderTrust: { enabled: false }, auth: { selectedType: "oauth-personal" } },
      general: { enableAutoUpdate: false, checkForUpdates: false },
      mcpServers: {},
    };
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    const proc = pty.spawn(
      "gemini",
      ["-m", "gemini-2.5-flash", "--approval-mode", "yolo", "-i", `Reply with exactly: ${token}`],
      {
        name: "xterm-color",
        cols: 80,
        rows: 24,
        cwd: dir,
        env: { ...process.env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath },
      },
    );
    let buf = "";
    proc.onData((d) => {
      buf += d;
    });
    const t0 = Date.now();
    let ok = false;
    while (Date.now() - t0 < 90000) {
      if (new RegExp(`${token}`).test(stripAnsi(buf).replace(new RegExp(`Reply with exactly: ${token}`), ""))) {
        ok = true;
        break;
      }
      await sleep(1000);
    }
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {}
    try {
      proc.kill();
    } catch {}
    results.push({ k, ok, ms: Date.now() - t0 });
    await sleep(1500);
  }
  return results;
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "ebi-gemini-e2e-"));
  const cwdDir = join(tmpDir, "workspace");
  mkdirSync(cwdDir, { recursive: true });
  writeFileSync(join(cwdDir, "README.md"), "# e2e workspace\n");
  process.env.EBI_E2E_CWD = cwdDir;

  console.log(`tmpDir: ${tmpDir}  rounds=${ROUNDS}  port=${PORT}`);
  console.log(`gemini: ${execFileSync("gemini", ["--version"], { encoding: "utf8" }).trim()}`);
  console.log(`GOOGLE_CLOUD_PROJECT=${process.env.GOOGLE_CLOUD_PROJECT ?? "(未設定)"}`);
  const before = geminiProcessCount();
  console.log(`開始時の gemini プロセス数: ${before}`);

  const mcpConfig = writeMcpConfig(tmpDir);
  const configPath = writeConfig(tmpDir);
  const srv = startServer(tmpDir, configPath, mcpConfig);
  const results = [];
  let ipResults = null;
  try {
    await sleep(3000);
    for (let i = 1; i <= ROUNDS; i++) {
      const r = await runRound(i);
      results.push(r);
      console.log(
        `  [round ${r.i}] delivered=${r.delivered} idle=${r.idle} backend=${r.backend} via=${r.via} ` +
          `leftover=${r.leftover} GEMINI.md=${r.geminiMd} ${Math.round(r.elapsedMs / 1000)}s`,
      );
      if (!r.delivered || process.env.EBI_E2E_DUMP === "1") {
        console.log(`  --- round ${r.i} scrollback 末尾 ---\n${r.tail}\n  ---`);
      }
      await sleep(1000);
    }
    if (process.env.EBI_E2E_INITIAL_PROMPT === "1") {
      console.log("\n--- 参考: `-i`（初回タスクを起動引数で渡す）方式 ---");
      ipResults = await measureInitialPrompt(join(tmpDir, "ip-runtime"));
      for (const r of ipResults) console.log(`  [-i ${r.k}] ok=${r.ok} ${Math.round(r.ms / 1000)}s`);
    }
  } finally {
    for (const r of results) await api.post("/control/kill", { id: r.id }).catch(() => {});
    srv.kill("SIGTERM");
    await sleep(2500);
    rmSync(tmpDir, { recursive: true, force: true });
  }

  await sleep(2000);
  const after = geminiProcessCount();
  const delivered = results.filter((r) => r.delivered).length;
  const idled = results.filter((r) => r.idle).length;
  const clean = results.filter((r) => r.leftover === 0).length;

  console.log("\n---- ラウンド内訳 ----");
  for (const r of results) {
    console.log(
      `  round ${String(r.i).padStart(2)}: delivered=${r.delivered ? "OK " : "NG "} ` +
        `idle=${r.idle ? "OK " : "NG "} 残存=${r.leftover} ${Math.round(r.elapsedMs / 1000)}s`,
    );
  }
  console.log(
    `\n==== reply 着弾 ${delivered}/${results.length} / idle 復帰 ${idled}/${results.length} / ` +
      `kill 後残存 0 が ${clean}/${results.length} ====`,
  );
  console.log(`gemini プロセス数: 開始 ${before} → 終了 ${after}（0 であること）`);

  const ok =
    results.length === ROUNDS &&
    delivered === ROUNDS &&
    idled === ROUNDS &&
    clean === ROUNDS &&
    after === 0;
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("例外:", e?.stack ?? e);
  process.exit(1);
});
