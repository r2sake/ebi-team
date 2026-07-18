// バッチB の E2E（実課金・実 Slack/Discord 接続なし）。
// minaebi を「固定エビ（kind=dynamic + pinned + notifySubscribe:false）」として config 宣言し、
// 別ポートの一時サーバで以下を確認する（実 claude は使わず bash ダミーで代替）:
//   1) minaebi が起動時に自動 spawn される（kind=dynamic, pinned=true が registry に乗る）
//   2) pinned の kill が拒否される（notice が返り、registry から消えない）
//   3) minaebi を「殺す」と自動再起動する（新しい pid で復活）
//   4) devChannelsAllowlist / notifySubscribe を含む config でもサーバが正常起動する
//
// 実 Slack/Discord へは一切接続しない（command=bash・channels フラグも付けない）。
// 環境変数 EBI_ID 等の混入を避けるため、子サーバの env から明示的に削除する。
//
// 実行: node scripts/e2e-fixed-minaebi.mjs

import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const PORT = 8811;
const WS_URL = `ws://localhost:${PORT}/ws`;

// minaebi は bash で常駐させる（殺されるまで生きるよう stdin 待ち）。
const tmpDir = mkdtempSync(join(tmpdir(), "ebi-e2e-minaebi-"));
const configPath = join(tmpDir, "ebi-team.config.json");
const config = {
  // 起動ゲート許可リストの追加（正確値）。command=bash なので実際のダイアログは出ないが、
  // config パース経路（loadDevChannelsAllowlist → spawnConfig マージ）が壊れないことを確認する。
  devChannelsAllowlist: ["plugin:slack@minaebi-local"],
  fixedEbi: [
    {
      id: "minaebi",
      kind: "dynamic",
      cwd: root,
      command: "bash",
      // bash は claude フラグ非対応（command が claude でないため args のみ渡る）。
      // 殺されるまで生かすために標準入力待ちにする。
      args: ["-c", "echo MINAEBI_UP; exec cat"],
      // 受信 PTY 固定（notification 購読を使わない）。config パース経路の確認を兼ねる。
      notifySubscribe: false,
    },
  ],
};
writeFileSync(configPath, JSON.stringify(config, null, 2));

const results = [];
const ok = (m) => { results.push(["OK", m]); console.log("  OK:", m); };
const fail = (m) => { results.push(["NG", m]); console.error("  NG:", m); };

let server;
function cleanup(code) {
  try { server?.kill("SIGTERM"); } catch {}
  setTimeout(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    process.exit(code);
  }, 500);
}

// ---- 一時サーバ起動（tsx で server/index.ts を直起動）----
// EBI_ID 等が親から混入しないよう、子 env から明示的に削除する。
const childEnv = { ...process.env };
delete childEnv.EBI_ID;
delete childEnv.EBI_MCP_ROLE;
delete childEnv.EBI_CONTROL_URL;

server = spawn(
  "node",
  ["--import", "tsx", "src/server/index.ts"],
  {
    cwd: root,
    env: {
      ...childEnv,
      EBI_PORT: String(PORT),
      EBI_COMMAND: "bash",
      EBI_CONFIG_PATH: configPath,
      EBI_DUMP_PATH: join(tmpDir, "registry.json"),
      EBI_IDLE_MS: "300",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
server.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
server.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));

const overall = setTimeout(() => { fail("全体タイムアウト"); finish(); }, 25000);

function finish() {
  clearTimeout(overall);
  const ng = results.filter((r) => r[0] === "NG");
  console.log(`\n==== E2E(minaebi) 結果: ${results.length - ng.length}/${results.length} OK ====`);
  cleanup(ng.length === 0 ? 0 : 1);
}

setTimeout(connect, 2500);

function connect() {
  const ws = new WebSocket(WS_URL);
  let registry = [];
  let minaebiPid1 = null;
  let phase = "await-fixed";

  const findById = (id) => registry.find((a) => a.id === id);

  ws.on("error", (e) => { fail("WS error: " + e.message); finish(); });
  ws.on("open", () => console.log("接続:", WS_URL));

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "registry") registry = msg.agents;
    if (msg.type === "notice") {
      console.log("  notice:", msg.id, msg.text);
      if (phase === "await-kill-reject" && msg.id === "minaebi" && msg.text.includes("削除できません")) {
        ok("pinned(minaebi) の kill が notice で拒否された");
        setTimeout(checkStillThere, 300);
      }
    }
  });

  setTimeout(step1_fixedSpawned, 1500);

  function step1_fixedSpawned() {
    const mina = findById("minaebi");
    if (mina && mina.kind === "dynamic" && mina.pinned) {
      ok("minaebi が自動 spawn（kind=dynamic, pinned=true）");
      minaebiPid1 = mina.pid;
    } else {
      fail("minaebi の自動 spawn を確認できない: " + JSON.stringify(mina));
    }
    // 2) pinned kill 拒否
    phase = "await-kill-reject";
    ws.send(JSON.stringify({ type: "kill", id: "minaebi" }));
  }

  function checkStillThere() {
    ws.send(JSON.stringify({ type: "list" }));
    setTimeout(() => {
      if (findById("minaebi")) ok("kill 拒否後も minaebi が registry に残っている");
      else fail("kill 拒否のはずが minaebi が消えた");
      step3_autoRestart();
    }, 300);
  }

  // 3) minaebi を実際に殺して自動再起動を確認（EOF で bash の cat を終わらせる）。
  function step3_autoRestart() {
    phase = "await-restart";
    console.log("minaebi へ EOF(\\x04) を送って bash を終了させる…");
    ws.send(JSON.stringify({ type: "input", id: "minaebi", data: "\x04" }));
    setTimeout(() => {
      ws.send(JSON.stringify({ type: "list" }));
      setTimeout(() => {
        const mina = findById("minaebi");
        if (mina && mina.pid && mina.pid !== minaebiPid1) {
          ok(`minaebi が自動再起動した（pid ${minaebiPid1} → ${mina.pid}）`);
        } else {
          fail("minaebi の自動再起動を確認できない: " + JSON.stringify(mina) + ` (旧pid=${minaebiPid1})`);
        }
        finish();
      }, 1000);
    }, 3500);
  }
}
