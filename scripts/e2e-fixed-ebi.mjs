// Phase3 バッチA の E2E（実課金なし）。
// EBI_COMMAND=bash + 一時 config で一時サーバを別ポート起動し、以下を確認する:
//  1) 固定エビが起動時に自動 spawn される（kind/pinned/model が registry に乗る）
//  2) pinned の kill が拒否される（notice が返り、registry から消えない）
//  3) 固定エビを「殺す」と自動再起動する（新しい pid で復活）
//  4) dynamic は従来どおり追加→削除できる
//
// 後始末: 一時サーバ・一時 config・bash プロセスは終了時に片付ける。

import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const PORT = 8799;
const WS_URL = `ws://localhost:${PORT}/ws`;

// fixed エビは bash で常駐させる。bash -c 'sleep ...' は終わると exit するので、
// 自動再起動テスト用に「殺されるまで生きる」よう read で待たせる。
const tmpDir = mkdtempSync(join(tmpdir(), "ebi-e2e-"));
const configPath = join(tmpDir, "ebi-team.config.json");
const config = {
  fixedEbi: [
    {
      id: "supervisor",
      kind: "supervisor",
      cwd: ".",
      model: "haiku",
      command: "bash",
      // bash は claude フラグ非対応なので args/appendSystemPrompt は付与されない（command が claude でないため）。
      // 殺されるまで生かすために標準入力待ちにする。
      args: ["-c", "echo SUPERVISOR_UP; exec cat"],
    },
    {
      id: "master",
      kind: "master",
      cwd: root,
      model: "opus",
      command: "bash",
      args: ["-c", "echo MASTER_UP; exec cat"],
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
server = spawn(
  "node",
  ["--import", "tsx", "src/server/index.ts"],
  {
    cwd: root,
    env: {
      ...process.env,
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
  console.log(`\n==== E2E 結果: ${results.length - ng.length}/${results.length} OK ====`);
  cleanup(ng.length === 0 ? 0 : 1);
}

// サーバ起動を少し待ってから接続。
setTimeout(connect, 2500);

function connect() {
  const ws = new WebSocket(WS_URL);
  let registry = [];
  let masterPid1 = null;
  let dynId = null;
  let phase = "await-fixed";

  const findById = (id) => registry.find((a) => a.id === id);

  ws.on("error", (e) => { fail("WS error: " + e.message); finish(); });

  ws.on("open", () => console.log("接続:", WS_URL));

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "registry") registry = msg.agents;
    if (msg.type === "notice") {
      console.log("  notice:", msg.id, msg.text);
      if (phase === "await-kill-reject" && msg.id === "master" && msg.text.includes("削除できません")) {
        ok("pinned(master) の kill が notice で拒否された");
        // master がまだ registry にいることを確認。
        setTimeout(checkMasterStillThere, 300);
      }
    }
  });

  // ---- 手順を時系列で進める ----
  // 1) 固定エビ自動 spawn の確認（接続後に registry が届くのを待つ）。
  setTimeout(step1_fixedSpawned, 1500);

  function step1_fixedSpawned() {
    const sup = findById("supervisor");
    const mas = findById("master");
    if (sup && sup.kind === "supervisor" && sup.pinned && sup.model === "haiku") {
      ok("supervisor が自動 spawn（kind=supervisor, pinned, model=haiku）");
    } else {
      fail("supervisor の自動 spawn を確認できない: " + JSON.stringify(sup));
    }
    if (mas && mas.kind === "master" && mas.pinned && mas.model === "opus") {
      ok("master が自動 spawn（kind=master, pinned, model=opus）");
      masterPid1 = mas.pid;
    } else {
      fail("master の自動 spawn を確認できない: " + JSON.stringify(mas));
    }
    // 2) pinned kill 拒否
    phase = "await-kill-reject";
    ws.send(JSON.stringify({ type: "kill", id: "master" }));
  }

  function checkMasterStillThere() {
    ws.send(JSON.stringify({ type: "list" }));
    setTimeout(() => {
      if (findById("master")) ok("kill 拒否後も master が registry に残っている");
      else fail("kill 拒否のはずが master が消えた");
      step3_autoRestart();
    }, 300);
  }

  // 3) 固定エビを実際に殺して自動再起動を確認。
  //    kill 拒否される WS 経由ではなく、bash プロセスを直接終わらせるため、
  //    PTY に "exit\n"... ではなく cat なので、stdin を閉じる代わりに
  //    プロセスを殺せないので、input で Ctrl-D 相当(EOT \x04) を送って cat を終わらせる。
  function step3_autoRestart() {
    phase = "await-restart";
    console.log("master へ EOF(\\x04) を送って bash を終了させる…");
    ws.send(JSON.stringify({ type: "input", id: "master", data: "\x04" }));
    // 再起動（バックオフ baseDelay 1s + spawn）を待って pid 変化を確認。
    setTimeout(() => {
      ws.send(JSON.stringify({ type: "list" }));
      setTimeout(() => {
        const mas = findById("master");
        if (mas && mas.pid && mas.pid !== masterPid1) {
          ok(`master が自動再起動した（pid ${masterPid1} → ${mas.pid}）`);
        } else {
          fail("master の自動再起動を確認できない: " + JSON.stringify(mas) + ` (旧pid=${masterPid1})`);
        }
        step4_dynamic();
      }, 1000);
    }, 3500);
  }

  // 4) dynamic の追加→削除。
  function step4_dynamic() {
    phase = "await-dynamic";
    const onSpawned = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "spawned" && msg.agent.kind === "dynamic") {
        dynId = msg.agent.id;
        ws.off("message", onSpawned);
        if (!msg.agent.pinned) ok(`dynamic を追加できた（${dynId}, pinned=false）`);
        else fail("dynamic が pinned になっている");
        // 削除
        ws.send(JSON.stringify({ type: "kill", id: dynId }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "list" }));
          setTimeout(() => {
            if (!findById(dynId)) ok(`dynamic を削除できた（${dynId}）`);
            else fail("dynamic の削除に失敗");
            finish();
          }, 300);
        }, 500);
      }
    };
    ws.on("message", onSpawned);
    ws.send(JSON.stringify({ type: "spawn", cwd: root }));
  }
}
