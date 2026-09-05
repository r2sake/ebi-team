// PR-M2 受け入れ e2e: ui:"chat" の master（ヘッドレス claude）をサーバごと立てて、
//   (1) WS `chatSend` → `chatEvent`(text) → `chatEvent`(turnEnd)
//   (2) POST /control/reverse-inject → `chatEvent`(inbound) → text/turnEnd
// が **連続 10 回 100%** で成立することを確認する。
//
// 実行（サブスク枠を実際に消費する。既定では走らせない）:
//   node scripts/e2e-master-chat.mjs
//   EBI_E2E_CHAT_ROUNDS=3 node scripts/e2e-master-chat.mjs   # 回数を減らす
//
// 安全条件:
//  - 稼働 control API（127.0.0.1:8787）には触らない。**専用ポート 8798** で自前のサーバを立てる。
//  - `.ebi-team/` は読むだけ（config も master-mcp も**書かない**）。生成物は mkdtemp 配下に作る。
//  - 停止は必ず PID 指定（srv.kill）。広域 pkill はしない。
//  - モデルは haiku（枠の消費を最小化する）。

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PORT = Number(process.env.EBI_E2E_CHAT_PORT ?? 8798);
const BASE = `http://127.0.0.1:${PORT}`;
const ROUNDS = Number(process.env.EBI_E2E_CHAT_ROUNDS ?? 10);
const MODEL = process.env.EBI_E2E_CHAT_MODEL ?? "haiku";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const results = [];
const ok = (m) => { results.push(true); console.log("  OK:", m); };
const fail = (m) => { results.push(false); console.error("  NG:", m); };

/** master 用の制御MCP config（chat モードは受信が stdin なので購読ループは回さない）。 */
function writeMasterMcp(dir) {
  const p = join(dir, "master-control.e2e.mcp.json");
  writeFileSync(
    p,
    `${JSON.stringify(
      {
        mcpServers: {
          "ebi-control": {
            command: process.execPath,
            args: ["--import", "tsx", join(ROOT, "src/mcp/control-server.ts")],
            cwd: ROOT,
            env: {
              EBI_CONTROL_URL: `http://127.0.0.1:${PORT}`,
              EBI_MCP_ROLE: "master",
              EBI_NOTIFY_SUBSCRIBE: "off",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return p;
}

/** master 1 体だけの使い捨て config（ui:"chat"）。 */
function writeConfig(dir) {
  const p = join(dir, "config.e2e.json");
  writeFileSync(
    p,
    `${JSON.stringify(
      {
        fixedEbi: [
          {
            id: "master",
            kind: "master",
            ui: "chat",
            brain: "claude",
            cwd: ROOT,
            model: MODEL,
            permissionMode: "auto",
            appendSystemPrompt:
              "あなたはテスト用のエコー係。受け取った本文に「output only XXX」という指示が含まれていたら、" +
              "その XXX トークンだけを1行で返す。ツールは一切使わない。それ以外は何も書かない。",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return p;
}

function startServer(tmpDir, configPath, masterMcp) {
  const proc = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      EBI_PORT: String(PORT),
      EBI_HOST: "127.0.0.1",
      EBI_CONFIG_PATH: configPath,
      EBI_MASTER_MCP_CONFIG: masterMcp,
      EBI_DUMP_PATH: join(tmpDir, "registry.json"),
      EBI_DELIVERY_LOG_PATH: join(tmpDir, "delivery.log"),
      EBI_FIXED_EBI_LOG_PATH: join(tmpDir, "fixed-ebi.log"),
      EBI_USAGE_HISTORY_PATH: join(tmpDir, "usage-history.jsonl"),
      EBI_MASTER_CHAT_LOG_PATH: join(tmpDir, "master-chat.jsonl"),
      EBI_VIEWERS_PATH: join(tmpDir, "viewers.json"),
      EBI_IDLE_NOTIFY: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  return proc;
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** WS を開き、chat 系メッセージを溜め込むクライアント。 */
async function openWs() {
  const ws = await new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    w.on("open", () => res(w));
    w.on("error", rej);
  });
  const state = { events: [], states: [], snapshots: [], usage: null, seqs: [] };
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "chatEvent") {
      state.events.push(msg.event);
      state.seqs.push(msg.seq);
    } else if (msg.type === "chatState") state.states.push(msg.state);
    else if (msg.type === "chatSnapshot") state.snapshots.push(msg);
    else if (msg.type === "usage") state.usage = msg;
  });
  return { ws, state };
}

/** 条件を満たすイベントが来るまで待つ（from 以降のみ見る）。 */
async function waitEvent(state, from, pred, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    for (let i = from; i < state.events.length; i++) {
      if (pred(state.events[i])) return { hit: state.events[i], index: i };
    }
    if (Date.now() >= until) return null;
    await sleep(200);
  }
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "ebi-m2-e2e-"));
  log(`tmpDir: ${tmpDir} / port ${PORT} / model ${MODEL} / rounds ${ROUNDS}`);
  const masterMcp = writeMasterMcp(tmpDir);
  const configPath = writeConfig(tmpDir, masterMcp);
  const srv = startServer(tmpDir, configPath, masterMcp);
  let client;

  try {
    // サーバ起動と master（chat）の idle 到達を待つ。
    await sleep(4000);
    client = await openWs();
    const { state } = client;
    const idle = await (async () => {
      const until = Date.now() + 60_000;
      while (Date.now() < until) {
        if (state.states.includes("idle")) return true;
        await sleep(300);
      }
      return false;
    })();
    if (idle) ok("master（chat）が起動して idle になった（PTY 無し）");
    else fail("master（chat）が idle にならない");

    // 接続直後に snapshot が届く（PR-M3 の再接続復元の土台）。
    if (state.snapshots.length > 0) ok("接続直後に chatSnapshot が届く");
    else fail("chatSnapshot が届かない");

    let sendOk = 0;
    let replyOk = 0;
    for (let round = 1; round <= ROUNDS; round++) {
      const token = `R${round}`;
      // ---- (1) chatSend → text / turnEnd ----
      let from = state.events.length;
      client.ws.send(
        JSON.stringify({
          type: "chatSend",
          id: "master",
          text: `テスト発話です。output only SEND_${token}`,
        }),
      );
      const user = await waitEvent(state, from, (e) => e.kind === "user", 10_000);
      const text = await waitEvent(
        state,
        from,
        (e) => e.kind === "text" && !e.partial && e.text.includes(`SEND_${token}`),
        180_000,
      );
      const end = await waitEvent(state, from, (e) => e.kind === "turnEnd", 180_000);
      if (user && text && end?.hit.ok) {
        sendOk++;
        log(`  round ${round}: chatSend OK（ctx ${end.hit.usage?.contextUsedPct ?? "—"}% / $${end.hit.totalCostUsd ?? "—"}）`);
      } else {
        fail(`round ${round}: chatSend 失敗（user=${!!user} text=${!!text} turnEnd=${end?.hit.ok}）`);
      }

      // ---- (2) reverse-inject → inbound / text / turnEnd ----
      from = state.events.length;
      const rev = await post("/control/reverse-inject", {
        from: "ebi-sim",
        to: "master",
        kind: "reply",
        message: `エビからの完了報告です。output only REPLY_${token}`,
      });
      const via = rev.body?.details?.[0]?.via;
      const inbound = await waitEvent(state, from, (e) => e.kind === "inbound", 30_000);
      const rtext = await waitEvent(
        state,
        from,
        (e) => e.kind === "text" && !e.partial && e.text.includes(`REPLY_${token}`),
        180_000,
      );
      const rend = await waitEvent(state, from, (e) => e.kind === "turnEnd", 180_000);
      if (rev.status === 200 && via === "chat" && inbound && rtext && rend?.hit.ok) {
        replyOk++;
        log(`  round ${round}: reverse-inject OK（via=${via} confirmed=${rev.body?.details?.[0]?.confirmed}）`);
      } else {
        fail(
          `round ${round}: reverse-inject 失敗（status=${rev.status} via=${via} inbound=${!!inbound} ` +
            `text=${!!rtext} turnEnd=${rend?.hit.ok}）`,
        );
      }
    }

    if (ROUNDS === 0) log("rounds=0 のため往復チェックはスキップ（中断チェックのみ）");
    else if (sendOk === ROUNDS) ok(`chatSend → text/turnEnd が ${sendOk}/${ROUNDS}（100%）`);
    else fail(`chatSend が ${sendOk}/${ROUNDS}`);
    if (ROUNDS === 0) {
      // no-op
    } else if (replyOk === ROUNDS) ok(`reverse-inject → inbound/text/turnEnd が ${replyOk}/${ROUNDS}（100%）`);
    else fail(`reverse-inject が ${replyOk}/${ROUNDS}`);

    // seq が単調増加している（再接続時の欠落検出の前提）。
    const monotonic = state.seqs.every((v, i) => i === 0 || v === state.seqs[i - 1] + 1);
    if (state.seqs.length === 0) log("seq チェックはイベントが無いのでスキップ");
    else if (monotonic) ok(`chatEvent の seq が単調増加（${state.seqs.length} 件）`);
    else fail(`seq が単調でない: ${state.seqs.slice(0, 20).join(",")}…`);

    // usage（statusLine の代替）が UsageStore に載っている（ターンを 1 度も回していない
    // rounds=0 モードでは判定しない）。
    const masterUsage = state.usage?.agents?.find((a) => a.id === "master");
    if (ROUNDS === 0) {
      log("rounds=0 のため usage チェックはスキップ");
    } else if (masterUsage?.contextUsedPct != null) {
      ok(`usage が UsageStore に載る（ctx ${masterUsage.contextUsedPct}% / size ${masterUsage.contextSize}）`);
    } else {
      fail("usage が UsageStore に載らない（contextGuard の入力が欠測）");
    }
    log(`rate limits（rate_limit_event 由来）: ${JSON.stringify(state.usage?.rateLimits ?? null)}`);

    // 中断（chatStop）で会話が壊れないこと。
    // エコー係の役割プロンプトに沿う形で「長い本文をそのまま吐かせる」ことでターンを引き延ばす
    //（普通の指示だと「何も書かない」で即終了し、interrupt が届く前にターンが終わる）。
    const from = state.events.length;
    client.ws.send(
      JSON.stringify({
        type: "chatSend",
        id: "master",
        text: `長文テストです。output only ${"ABCDEFGHIJ ".repeat(400)}`,
      }),
    );
    await sleep(3000);
    const finishedEarly = await waitEvent(state, from, (e) => e.kind === "turnEnd", 1);
    if (finishedEarly) {
      log("SKIP: 中断チェック（interrupt を送る前にターンが終わった。中断は e2e-master-brain.mjs で実測済み）");
    } else {
      client.ws.send(JSON.stringify({ type: "chatStop", id: "master" }));
      const aborted = await waitEvent(state, from, (e) => e.kind === "turnEnd", 60_000);
      if (aborted?.hit.aborted === true && aborted.hit.errorText === null) {
        ok("chatStop で turnEnd{aborted:true}（通常エラーに化けない）");
      } else {
        fail(`chatStop の turnEnd が中断扱いにならない: ${JSON.stringify(aborted?.hit ?? null)}`);
      }
    }
  } finally {
    try {
      client?.ws.close();
    } catch {}
    srv.kill("SIGTERM");
    await sleep(2500);
    if (srv.exitCode === null) srv.kill("SIGKILL");
    log(`会話ログ: ${join(tmpDir, "master-chat.jsonl")}（tmpDir は残す: ${tmpDir}）`);
    void rmSync;
  }

  const okCount = results.filter(Boolean).length;
  console.log(`\n==== master chat e2e: ${okCount}/${results.length} OK ====`);
  process.exit(okCount === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("例外:", e?.stack ?? e);
  process.exit(1);
});
