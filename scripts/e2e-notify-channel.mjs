// notification 注入方式（EBI_INJECT_MODE=notify）の live e2e。実 claude(haiku) を使う。
//
// この worktree の実装前提:
//   - src/mcp/control-server.ts が capabilities.experimental["claude/channel"] を宣言
//   - notify モード時、spawn 引数に --dangerously-load-development-channels server:ebi-control を付与
//   - agent.ts の起動ゲート自動応答が、ready 前に development channels / workspace trust
//     ダイアログへ "1\r" を自動送信する（安全限定: dev-channels 値が server:ebi-control 1個のみ）
//   ＝この e2e はテスト側でダイアログに触らない。サーバ実装の自動応答をそのまま検証する。
//
// 検証項目:
//   ① 注入成立（回帰）: master→ebi-a 送信 → 受信側が channel 経由で受信し応答
//   ② エビ2体の相互送信: ebi-a→ebi-b / ebi-b→ebi-a
//   ③ 受信側 busy 中の配送: sleep 実行中でも取りこぼさず処理
//   ④ spawnIfMissing: /control/send が spawn→ダイアログ自動応答→購読確立→配送まで一気通貫
//   ⑤ EBI_INJECT_MODE=pty ロールバック: 旧 PTY 経路が無傷
//   ⑥ notify × --strict-mcp-config 共存
//
// 安全策: 本番(8787)不可侵。専用ポート 8797/8798/8799 + mkdtemp 状態ディレクトリで完結し、
// spawn した claude は全て kill する。エビの cwd は固定パス CWD_DIR（初回に notify サーバの
// 自動応答が trust ダイアログを承認 → 以降 trust 済み。⑤ pty はこの後に走らせて再利用する）。

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CWD_DIR = "/tmp/ebi-notify-e2e-cwd";
mkdirSync(CWD_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const gateLogs = [];
const ok = (m) => { results.push(true); console.log("  OK:", m); };
const fail = (m) => { results.push(false); console.error("  NG:", m); };

function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "");
}

function api(base) {
  return {
    async get(path) {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async post(path, body) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async scrollback(id) {
      const r = await this.get(`/control/scrollback?id=${id}`);
      return stripAnsi(r.body?.data ?? "");
    },
    async waitForText(id, pattern, timeoutMs) {
      const start = Date.now();
      for (;;) {
        const txt = await this.scrollback(id);
        if (pattern.test(txt)) return { found: true, txt };
        if (Date.now() - start >= timeoutMs) return { found: false, txt };
        await sleep(2000);
      }
    },
    async status(id) {
      const r = await this.get("/control/agents");
      return (r.body?.agents ?? []).find((x) => x.id === id)?.status;
    },
    async waitStatus(id, want, timeoutMs) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if ((await this.status(id)) === want) return true;
        await sleep(400);
      }
      return false;
    },
  };
}

function writeMcpConfig(dir, port, role) {
  const p = join(dir, `${role}-control.e2e.mcp.json`);
  writeFileSync(
    p,
    JSON.stringify(
      {
        mcpServers: {
          "ebi-control": {
            command: "npx",
            args: ["tsx", join(ROOT, "src/mcp/control-server.ts")],
            cwd: ROOT,
            env: { EBI_CONTROL_URL: `http://127.0.0.1:${port}`, EBI_MCP_ROLE: role },
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  return p;
}

/** サーバを起動。stdout から購読確立 id と起動ゲート自動応答ログを拾う。 */
function startServer({ port, tmpDir, extraEnv }) {
  const engineerCfg = writeMcpConfig(tmpDir, port, "engineer");
  const subscribed = new Set();
  const proc = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      EBI_PORT: String(port),
      EBI_HOST: "127.0.0.1",
      EBI_DEFAULT_CWD: CWD_DIR,
      EBI_DUMP_PATH: join(tmpDir, `registry-${port}.json`),
      EBI_CONFIG_PATH: join(tmpDir, "no-fixed-ebi.json"), // 存在しない = 固定エビ無し
      EBI_ENGINEER_MCP_CONFIG: engineerCfg,
      EBI_READY_WAIT_MS: "70000",
      EBI_SUBSCRIBE_WAIT_MS: "70000",
      EBI_IDLE_NOTIFY: "off",
      // 既定は notify（この worktree）。⑤の pty ブロックだけ extraEnv で上書きする。
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => {
    const s = String(d);
    const m = s.match(/notification 購読が確立: id=(\S+)/);
    if (m) subscribed.add(m[1]);
    if (/起動ゲート自動応答/.test(s)) {
      for (const line of s.split("\n")) {
        if (line.includes("起動ゲート自動応答")) gateLogs.push(line.trim());
      }
    }
    process.stdout.write(`[srv:${port}] ${s}`);
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[srv:${port}-err] ${d}`));
  return { proc, subscribed };
}

async function waitSubscribed(subscribed, id, timeoutMs) {
  const start = Date.now();
  while (!subscribed.has(id) && Date.now() - start < timeoutMs) await sleep(1000);
  return subscribed.has(id);
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "ebi-notify-e2e-"));
  console.log("tmpDir:", tmpDir, " cwd:", CWD_DIR);

  // ===== notify サーバ（①〜④）=====
  const PORT = 8797;
  const A = api(`http://127.0.0.1:${PORT}`);
  const { proc: srv, subscribed } = startServer({ port: PORT, tmpDir });
  await sleep(2000);
  const spawnedA = [];

  try {
    // ① 注入成立（回帰）
    console.log("\n--- ① master→ebi-a: notify 注入（サーバ自動応答で spawn→購読確立）---");
    // 注意: /control/spawn は id 指定を無視して動的採番するため、応答の実IDで以降を追う
    const rA = await A.post("/control/spawn", { id: "ebi-a", role: "engineer", model: "haiku" });
    const idA = rA.body?.id;
    if (rA.status === 200 && idA) { spawnedA.push(idA); ok(`ebi-a spawn（実ID=${idA}）`); }
    else { fail("ebi-a spawn 失敗: " + JSON.stringify(rA)); }
    const subA = await waitSubscribed(subscribed, idA, 70000);
    if (subA) ok("ebi-a 購読確立（起動ダイアログはサーバが自動応答したはず）");
    else fail("ebi-a 購読が確立しない");
    const inj1 = await A.post("/control/inject", {
      to: idA, from: "master",
      message: "疎通テスト1です。読めたら他には何も書かず ACK_NOTIFY_1 とだけ返答してください。ツールは使わないでください。",
    });
    if (inj1.status === 200 && (inj1.body?.delivered ?? []).includes(idA)) ok("inject 受理");
    else fail("inject 失敗: " + JSON.stringify(inj1));
    const w1 = await A.waitForText(idA, /ACK_NOTIFY_1/, 90000);
    if (w1.found) ok("① ebi-a が channel 経由で受信・応答（ACK_NOTIFY_1）");
    else { fail("① ACK_NOTIFY_1 未検出"); console.log(w1.txt.slice(-1000)); }

    // ② エビ2体の相互送信
    console.log("\n--- ② ebi-a ⇄ ebi-b 相互送信 ---");
    const rB = await A.post("/control/spawn", { id: "ebi-b", role: "engineer", model: "haiku" });
    const idB = rB.body?.id;
    if (rB.status === 200 && idB) { spawnedA.push(idB); ok(`ebi-b spawn（実ID=${idB}）`); }
    else fail("ebi-b spawn 失敗: " + JSON.stringify(rB));
    const subB = await waitSubscribed(subscribed, idB, 70000);
    if (subB) ok("ebi-b 購読確立");
    else fail("ebi-b 購読が確立しない");
    const ab = await A.post("/control/inject", {
      to: idB, from: idA,
      message: "相互送信(a→b)です。読めたら他には何も書かず ACK_A_TO_B とだけ返答してください。ツールは使わないでください。",
    });
    const ba = await A.post("/control/inject", {
      to: idA, from: idB,
      message: "相互送信(b→a)です。読めたら他には何も書かず ACK_B_TO_A とだけ返答してください。ツールは使わないでください。",
    });
    if (ab.status === 200 && (ab.body?.delivered ?? []).includes(idB)) ok("a→b 配送受理");
    else fail("a→b 失敗: " + JSON.stringify(ab));
    if (ba.status === 200 && (ba.body?.delivered ?? []).includes(idA)) ok("b→a 配送受理");
    else fail("b→a 失敗: " + JSON.stringify(ba));
    const wAB = await A.waitForText(idB, /ACK_A_TO_B/, 90000);
    const wBA = await A.waitForText(idA, /ACK_B_TO_A/, 90000);
    if (wAB.found) ok("② ebi-b が a→b を受信・応答");
    else { fail("② ACK_A_TO_B 未検出"); console.log(wAB.txt.slice(-800)); }
    if (wBA.found) ok("② ebi-a が b→a を受信・応答");
    else { fail("② ACK_B_TO_A 未検出"); console.log(wBA.txt.slice(-800)); }

    // ③ busy 中の配送
    console.log("\n--- ③ busy 中の配送 ---");
    await A.post("/control/inject", {
      to: idA, from: "master",
      message: "Bash ツールで `sleep 20` を実行してください。他には何もしないでください。",
    });
    const becameBusy = await A.waitStatus(idA, "busy", 15000);
    console.log(`  (info) ebi-a busy 到達: ${becameBusy}`);
    const injBusy = await A.post("/control/inject", {
      to: idA, from: "master",
      message: "busy 中テストです。読めたら他には何も書かず ACK_BUSY とだけ返答してください。ツールは使わないでください。",
    });
    if (injBusy.status === 200) ok("busy 中送信が受理（notify は busy/idle 無関係）");
    else fail("busy 中送信 失敗: " + JSON.stringify(injBusy));
    const wBusy = await A.waitForText(idA, /ACK_BUSY/, 120000);
    if (wBusy.found) ok("③ busy 中メッセージを取りこぼさず処理");
    else { fail("③ ACK_BUSY 未検出"); console.log(wBusy.txt.slice(-1000)); }

    // ④ spawnIfMissing（spawn→自動応答→購読確立→配送 の全区間）
    console.log("\n--- ④ spawnIfMissing 一気通貫 ---");
    const snd = await A.post("/control/send", {
      to: "ebi-fresh",
      message: "spawnIfMissing テストです。読めたら他には何も書かず ACK_FRESH とだけ返答してください。ツールは使わないでください。",
      spawnIfMissing: true, role: "engineer", model: "haiku",
    });
    spawnedA.push("ebi-fresh");
    if (snd.status === 200 && snd.body?.ok && snd.body?.spawned) ok("send(spawnIfMissing) 受理: " + JSON.stringify(snd.body));
    else fail("send(spawnIfMissing) 失敗: " + JSON.stringify(snd));
    const wFresh = await A.waitForText("ebi-fresh", /ACK_FRESH/, 90000);
    if (wFresh.found) ok("④ spawn→自動応答→購読確立→配送→応答 の全区間成立");
    else { fail("④ ACK_FRESH 未検出"); console.log(wFresh.txt.slice(-1200)); }

    for (const id of spawnedA) await A.post("/control/kill", { id });
    await sleep(500);
  } finally {
    srv.kill("SIGTERM");
    await sleep(1200);
  }

  // ===== ⑥ notify × --strict-mcp-config 共存 =====
  console.log("\n--- ⑥ notify × --strict-mcp-config 共存 ---");
  {
    const PORT3 = 8799;
    const C = api(`http://127.0.0.1:${PORT3}`);
    const { proc: srv3, subscribed: sub3 } = startServer({
      port: PORT3, tmpDir, extraEnv: { EBI_ARGS: "--strict-mcp-config" },
    });
    await sleep(2000);
    try {
      const r = await C.post("/control/spawn", { id: "ebi-strict", role: "engineer", model: "haiku" });
      const idS = r.body?.id;
      if (r.status === 200 && idS) ok(`strict サーバで spawn（実ID=${idS}）`);
      else fail("strict spawn 失敗: " + JSON.stringify(r));
      const sub = await waitSubscribed(sub3, idS, 70000);
      if (sub) ok("⑥ strict 共存でも購読確立（--strict-mcp-config + 明示 --mcp-config + channel フラグ）");
      else fail("⑥ strict 共存で購読が確立しない");
      const inj = await C.post("/control/inject", {
        to: idS, from: "master",
        message: "strict 共存テストです。読めたら他には何も書かず ACK_STRICT とだけ返答してください。ツールは使わないでください。",
      });
      if (inj.status === 200) ok("strict 共存で inject 受理");
      else fail("strict inject 失敗: " + JSON.stringify(inj));
      const w = await C.waitForText(idS, /ACK_STRICT/, 90000);
      if (w.found) ok("⑥ strict 共存でも notify 注入が成立");
      else { fail("⑥ ACK_STRICT 未検出"); console.log(w.txt.slice(-1200)); }
      await C.post("/control/kill", { id: idS });
      await sleep(500);
    } finally {
      srv3.kill("SIGTERM");
      await sleep(1200);
    }
  }

  // ===== ⑤ EBI_INJECT_MODE=pty ロールバック（cwd は既に trust 済み）=====
  console.log("\n--- ⑤ EBI_INJECT_MODE=pty ロールバック ---");
  {
    const PORT2 = 8798;
    const B = api(`http://127.0.0.1:${PORT2}`);
    const { proc: srv2 } = startServer({ port: PORT2, tmpDir, extraEnv: { EBI_INJECT_MODE: "pty" } });
    await sleep(2000);
    try {
      const snd = await B.post("/control/send", {
        to: "ebi-pty",
        message: "PTY ロールバックテストです。読めたら他には何も書かず ACK_PTY とだけ返答してください。ツールは使わないでください。",
        spawnIfMissing: true, role: "engineer", model: "haiku",
      });
      if (snd.status === 200 && snd.body?.ok) ok("pty モードで send 受理");
      else fail("pty send 失敗: " + JSON.stringify(snd));
      const w = await B.waitForText("ebi-pty", /ACK_PTY/, 90000);
      if (w.found) ok("⑤ EBI_INJECT_MODE=pty で旧 PTY 経路が正常動作（ロールバック健全）");
      else { fail("⑤ ACK_PTY 未検出"); console.log(w.txt.slice(-1200)); }
      await B.post("/control/kill", { id: "ebi-pty" });
      await sleep(500);
    } finally {
      srv2.kill("SIGTERM");
      await sleep(1200);
    }
  }

  rmSync(tmpDir, { recursive: true, force: true });
  console.log("\n---- 起動ゲート自動応答ログ（発火例）----");
  for (const l of gateLogs.slice(0, 20)) console.log("  " + l);
  const okCount = results.filter(Boolean).length;
  console.log(`\n==== notify channel live e2e 結果: ${okCount}/${results.length} OK（gate 自動応答 ${gateLogs.length} 回）====`);
  process.exit(okCount === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("例外:", e?.stack ?? e);
  process.exit(1);
});
