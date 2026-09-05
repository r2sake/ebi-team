// PR-M5 受け入れ e2e: master チャットの「承認 / 質問」往復。
//
// 確認すること:
//   (1) 未応答のあいだ master は止まり、UI に待ち件数（chatState.pending / waiting）が出る
//   (2) 承認するとツール実行が継続する（tool_result が返り turnEnd が成立する）
//   (3) 拒否するとツールは実行されず、会話は続けられる
//   (4) AskUserQuestion の選択肢応答が claude 側へ届く（answers として復唱される）
//   (5) 「新しい会話」で未応答の保留は破棄され、UI に破棄が出る
//   (6) サーバを強制終了しても、再起動後の snapshot で保留が「破棄」として復元される
//
// 実行:
//   node scripts/e2e-master-chat-approval.mjs
//   EBI_E2E_APPROVAL_REAL=0 node scripts/e2e-master-chat-approval.mjs   # 実 claude 部分を省く
//
// 枠の使い方:
//  - (1)〜(6) は **偽 claude（scripts/fake-claude-stream.mjs）** を PATH の先頭に置いて回すので
//    サブスク枠も課金も一切消費しない。
//  - 最後に **実 claude（haiku）で承認往復 1 回・質問応答 1 回だけ** 回し、
//    `--permission-prompt-tool` → 制御MCP（permission_prompt）→ 制御API の実配線を確かめる。
//
// 安全条件:
//  - 稼働 control API（127.0.0.1:8787）には触らない。**専用ポート 8799 / 8800** を使う。
//  - `.ebi-team/` は読むだけ（config も master-mcp も書かない）。生成物は mkdtemp 配下。
//  - 停止は必ず PID 指定（srv.kill）。広域 pkill はしない。

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FAKE_PORT = Number(process.env.EBI_E2E_APPROVAL_PORT ?? 8799);
const REAL_PORT = Number(process.env.EBI_E2E_APPROVAL_REAL_PORT ?? 8800);
const RUN_REAL = (process.env.EBI_E2E_APPROVAL_REAL ?? "1") !== "0";
const MODEL = process.env.EBI_E2E_APPROVAL_MODEL ?? "haiku";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const results = [];
const ok = (m) => { results.push(true); console.log("  OK:", m); };
const fail = (m) => { results.push(false); console.error("  NG:", m); };

/** master 1 体だけの使い捨て config（ui:"chat"）。 */
function writeConfig(dir, appendSystemPrompt) {
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
            appendSystemPrompt,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return p;
}

/** master 用の制御MCP config（chat モードは受信が stdin なので購読ループは回さない）。 */
function writeMasterMcp(dir, port) {
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
              EBI_CONTROL_URL: `http://127.0.0.1:${port}`,
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

/** 偽 claude を `claude` という名前で PATH の先頭に置く（実 claude を起動させない）。 */
function writeFakeClaude(dir) {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const p = join(binDir, "claude");
  writeFileSync(p, `#!/bin/sh\nexec ${process.execPath} ${join(ROOT, "scripts/fake-claude-stream.mjs")} "$@"\n`);
  chmodSync(p, 0o755);
  return binDir;
}

function startServer({ port, tmpDir, configPath, masterMcp, pathPrefix }) {
  const proc = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...(pathPrefix ? { PATH: `${pathPrefix}:${process.env.PATH}` } : {}),
      EBI_PORT: String(port),
      EBI_HOST: "127.0.0.1",
      EBI_CONTROL_URL: `http://127.0.0.1:${port}`,
      EBI_CONFIG_PATH: configPath,
      EBI_MASTER_MCP_CONFIG: masterMcp,
      EBI_DUMP_PATH: join(tmpDir, "registry.json"),
      EBI_DELIVERY_LOG_PATH: "off",
      EBI_FIXED_EBI_LOG_PATH: "off",
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

/** WS を開き、chat 系メッセージを溜め込むクライアント。 */
async function openWs(port) {
  const ws = await new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    w.on("open", () => res(w));
    w.on("error", rej);
  });
  const state = { events: [], states: [], snapshots: [] };
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "chatEvent") state.events.push(msg.event);
    else if (msg.type === "chatState") state.states.push(msg);
    else if (msg.type === "chatSnapshot") state.snapshots.push(msg);
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
    await sleep(150);
  }
}

/** 条件を満たす chatState が来るまで待つ。 */
async function waitState(state, pred, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    for (let i = state.states.length - 1; i >= 0; i--) {
      if (pred(state.states[i])) return state.states[i];
    }
    if (Date.now() >= until) return null;
    await sleep(150);
  }
}

async function waitIdle(state, timeoutMs = 60_000) {
  return waitState(state, (s) => s.state === "idle", timeoutMs);
}

async function stopServer(srv) {
  srv.kill("SIGTERM");
  await sleep(2500);
  if (srv.exitCode === null) srv.kill("SIGKILL");
}

// ===== (1)〜(6): 偽 claude（枠消費ゼロ）=====

async function runFakePhase() {
  const tmpDir = mkdtempSync(join(tmpdir(), "ebi-m5-fake-"));
  log(`[fake] tmpDir: ${tmpDir} / port ${FAKE_PORT}`);
  const configPath = writeConfig(tmpDir, "テスト用");
  const masterMcp = writeMasterMcp(tmpDir, FAKE_PORT);
  const binDir = writeFakeClaude(tmpDir);
  let srv = startServer({ port: FAKE_PORT, tmpDir, configPath, masterMcp, pathPrefix: binDir });
  let client = null;

  try {
    await sleep(3500);
    client = await openWs(FAKE_PORT);
    const { state } = client;
    if (await waitIdle(state)) ok("[fake] master（chat）が idle になった");
    else return fail("[fake] master（chat）が idle にならない");

    // ---- (1) 未応答のあいだは止まる ----
    let from = state.events.length;
    client.ws.send(JSON.stringify({ type: "chatSend", id: "master", text: "perm:Bash:rm -f /tmp/ebi-m5-x" }));
    const perm = await waitEvent(state, from, (e) => e.kind === "permission", 20_000);
    if (perm?.hit.toolName === "Bash") ok("[fake] 承認要求が chatEvent(permission) として UI へ出る");
    else fail(`[fake] permission イベントが出ない: ${JSON.stringify(perm?.hit ?? null)}`);

    const waiting = await waitState(state, (s) => s.state === "waiting" && s.pending === 1, 10_000);
    if (waiting) ok("[fake] 未応答のあいだ waiting / pending=1（UI のスティッキーバーの入力）");
    else fail(`[fake] waiting/pending が立たない: ${JSON.stringify(state.states.slice(-3))}`);

    await sleep(2500);
    const early = await waitEvent(state, from, (e) => e.kind === "turnEnd", 1);
    if (!early) ok("[fake] 未応答のあいだ master は止まったまま（turnEnd が来ない）");
    else fail("[fake] 未応答なのにターンが終わってしまった");

    // ---- (2) 承認 → ツール実行が継続する ----
    client.ws.send(
      JSON.stringify({ type: "chatAnswer", id: "master", requestId: perm.hit.id, allow: true }),
    );
    const settled = await waitEvent(
      state,
      from,
      (e) => e.kind === "permissionSettled" && e.id === perm.hit.id,
      20_000,
    );
    const ran = await waitEvent(
      state,
      from,
      (e) => e.kind === "toolResult" && e.ok && e.content.includes("実行しました"),
      20_000,
    );
    const end = await waitEvent(state, from, (e) => e.kind === "turnEnd", 20_000);
    if (settled?.hit.outcome === "allowed" && ran && end?.hit.ok) {
      ok("[fake] 承認するとツール実行が継続し、ターンが完走する");
    } else {
      fail(
        `[fake] 承認往復が成立しない（settled=${settled?.hit.outcome} tool=${!!ran} turnEnd=${end?.hit.ok}）`,
      );
    }
    const back = await waitState(state, (s) => s.state === "idle" && s.pending === 0, 10_000);
    if (back) ok("[fake] 応答後に pending=0 へ戻る");
    else fail("[fake] pending が 0 に戻らない");

    // ---- (3) 拒否 → ツールは実行されず、会話は続く ----
    from = state.events.length;
    client.ws.send(JSON.stringify({ type: "chatSend", id: "master", text: "perm:Bash:rm -rf /" }));
    const perm2 = await waitEvent(state, from, (e) => e.kind === "permission", 20_000);
    client.ws.send(
      JSON.stringify({
        type: "chatAnswer",
        id: "master",
        requestId: perm2.hit.id,
        allow: false,
        text: "危険なので拒否",
      }),
    );
    const denied = await waitEvent(
      state,
      from,
      (e) => e.kind === "permissionSettled" && e.outcome === "denied",
      20_000,
    );
    const blocked = await waitEvent(
      state,
      from,
      (e) => e.kind === "toolResult" && !e.ok && e.content.includes("危険なので拒否"),
      20_000,
    );
    const end2 = await waitEvent(state, from, (e) => e.kind === "turnEnd", 20_000);
    if (denied && blocked && end2?.hit.ok) ok("[fake] 拒否するとツールは実行されず、会話は続く");
    else fail(`[fake] 拒否経路が成立しない（settled=${!!denied} blocked=${!!blocked} end=${end2?.hit.ok}）`);

    from = state.events.length;
    client.ws.send(JSON.stringify({ type: "chatSend", id: "master", text: "拒否のあとの普通の発話" }));
    const after = await waitEvent(state, from, (e) => e.kind === "turnEnd" && e.ok, 20_000);
    if (after) ok("[fake] 拒否のあとも次の発話が通る（会話が壊れない）");
    else fail("[fake] 拒否のあと会話が続かない");

    // ---- (4) AskUserQuestion の選択肢応答 ----
    from = state.events.length;
    client.ws.send(
      JSON.stringify({ type: "chatSend", id: "master", text: "ask:昼食はどちら？|寿司,ラーメン" }),
    );
    const q = await waitEvent(state, from, (e) => e.kind === "question", 20_000);
    const labels = (q?.hit.options ?? []).map((o) => o.label);
    if (q && labels.join(",") === "寿司,ラーメン") ok(`[fake] 質問が選択肢付きで UI へ出る（${labels.join(" / ")}）`);
    else fail(`[fake] question イベントが期待の形でない: ${JSON.stringify(q?.hit ?? null)}`);
    client.ws.send(
      JSON.stringify({ type: "chatAnswer", id: "master", requestId: q.hit.id, choice: ["ラーメン"] }),
    );
    const answered = await waitEvent(
      state,
      from,
      (e) => e.kind === "toolResult" && e.content.includes('="ラーメン"'),
      20_000,
    );
    const end3 = await waitEvent(state, from, (e) => e.kind === "turnEnd", 20_000);
    if (answered && end3?.hit.ok) ok("[fake] 選択肢の回答が claude 側の tool_result まで届く");
    else fail(`[fake] 質問応答が届かない（tool_result=${!!answered} end=${end3?.hit.ok}）`);

    // ---- (5) 新しい会話で保留を破棄する ----
    from = state.events.length;
    client.ws.send(JSON.stringify({ type: "chatSend", id: "master", text: "perm:Bash:sleep 999" }));
    const perm3 = await waitEvent(state, from, (e) => e.kind === "permission", 20_000);
    client.ws.send(JSON.stringify({ type: "chatNew", id: "master" }));
    const discarded = await waitEvent(
      state,
      from,
      (e) => e.kind === "permissionSettled" && e.id === perm3.hit.id && e.outcome === "discarded",
      30_000,
    );
    const cleared = await waitState(state, (s) => s.pending === 0 && s.state !== "waiting", 30_000);
    if (discarded && cleared) ok("[fake] 新しい会話で保留が破棄され、UI に破棄が出る");
    else fail(`[fake] 新しい会話で保留が破棄されない（settled=${!!discarded} pending=${cleared?.pending}）`);

    // ---- (6) サーバ強制終了 → 再起動後の snapshot で破棄が復元される ----
    await waitIdle(state, 30_000);
    from = state.events.length;
    client.ws.send(JSON.stringify({ type: "chatSend", id: "master", text: "perm:Bash:sleep 998" }));
    const perm4 = await waitEvent(state, from, (e) => e.kind === "permission", 20_000);
    // 会話ログ（JSONL）の書き込みが落ち着くのを待ってから落とす。
    await sleep(1000);
    client.ws.close();
    client = null;
    // 強制終了（SIGKILL）＝会話ログに「破棄」が書かれないまま落ちる状況を作る。
    srv.kill("SIGKILL");
    await sleep(1500);
    srv = startServer({ port: FAKE_PORT, tmpDir, configPath, masterMcp, pathPrefix: binDir });
    await sleep(4000);
    client = await openWs(FAKE_PORT);
    await waitIdle(client.state, 60_000);
    const snap = client.state.snapshots[0];
    const restored = (snap?.events ?? []).some(
      (e) =>
        e.event.kind === "permissionSettled" &&
        e.event.id === perm4.hit.id &&
        e.event.outcome === "discarded",
    );
    if (restored) ok("[fake] サーバ再起動後、復元された保留は「破棄」として出る");
    else fail("[fake] 再起動後に保留が破棄として復元されない");
  } finally {
    try {
      client?.ws.close();
    } catch {}
    await stopServer(srv);
    log(`[fake] 会話ログ: ${join(tmpDir, "master-chat.jsonl")}（tmpDir は残す）`);
  }
}

// ===== 実 claude（haiku）で最小限の実配線確認 =====

async function runRealPhase() {
  const tmpDir = mkdtempSync(join(tmpdir(), "ebi-m5-real-"));
  const target = join(tmpDir, "target.txt");
  writeFileSync(target, "消してよいテスト用ファイル\n");
  log(`[real] tmpDir: ${tmpDir} / port ${REAL_PORT} / model ${MODEL}`);
  const configPath = writeConfig(
    tmpDir,
    "あなたはテスト用の作業係。指示された操作だけを最小限に行い、余計な説明はしない。",
  );
  const masterMcp = writeMasterMcp(tmpDir, REAL_PORT);
  const srv = startServer({ port: REAL_PORT, tmpDir, configPath, masterMcp, pathPrefix: null });
  let client = null;

  try {
    await sleep(4000);
    client = await openWs(REAL_PORT);
    const { state } = client;
    if (await waitIdle(state)) ok("[real] master（chat）が idle になった");
    else return fail("[real] master（chat）が idle にならない");

    // ---- 承認往復 1 回 ----
    let from = state.events.length;
    client.ws.send(
      JSON.stringify({
        type: "chatSend",
        id: "master",
        text: `bash で \`rm -f ${target}\` を実行してください。実行したら done とだけ答えて。`,
      }),
    );
    const perm = await waitEvent(state, from, (e) => e.kind === "permission", 180_000);
    if (perm) {
      ok(`[real] --permission-prompt-tool → 制御MCP → UI に承認要求が届く（${perm.hit.toolName}）`);
    } else {
      fail("[real] 承認要求が届かない（--permission-prompt-tool の配線を確認）");
      return;
    }
    client.ws.send(
      JSON.stringify({ type: "chatAnswer", id: "master", requestId: perm.hit.id, allow: true }),
    );
    const end = await waitEvent(state, from, (e) => e.kind === "turnEnd", 180_000);
    await sleep(500);
    if (end?.hit.ok && !existsSync(target)) ok("[real] 承認するとツールが実際に実行される（ファイルが消えた）");
    else fail(`[real] 承認後にツールが実行されない（turnEnd=${end?.hit.ok} exists=${existsSync(target)}）`);

    // ---- 質問応答 1 回 ----
    from = state.events.length;
    client.ws.send(
      JSON.stringify({
        type: "chatSend",
        id: "master",
        text:
          "AskUserQuestion ツールを必ず使って『昼食は寿司とラーメンのどちらがよいか』を質問してください。" +
          "回答を受け取ったら、その回答をそのまま復唱してください。",
      }),
    );
    const q = await waitEvent(state, from, (e) => e.kind === "question", 180_000);
    if (q?.hit.options?.length >= 2) {
      ok(`[real] AskUserQuestion が選択肢 UI として届く（${q.hit.options.map((o) => o.label).join(" / ")}）`);
    } else {
      fail(`[real] question イベントが届かない: ${JSON.stringify(q?.hit ?? null)}`);
      return;
    }
    const pick = q.hit.options[1].label;
    client.ws.send(
      JSON.stringify({ type: "chatAnswer", id: "master", requestId: q.hit.id, choice: [pick] }),
    );
    const echoed = await waitEvent(
      state,
      from,
      (e) => e.kind === "text" && !e.partial && e.text.includes(pick),
      180_000,
    );
    const end2 = await waitEvent(state, from, (e) => e.kind === "turnEnd", 180_000);
    if (echoed && end2?.hit.ok) ok(`[real] 選択肢の回答が claude に届く（「${pick}」を復唱した）`);
    else fail(`[real] 質問応答が届かない（復唱=${!!echoed} turnEnd=${end2?.hit.ok}）`);
  } finally {
    try {
      client?.ws.close();
    } catch {}
    await stopServer(srv);
    log(`[real] 会話ログ: ${join(tmpDir, "master-chat.jsonl")}（tmpDir は残す）`);
  }
}

async function main() {
  await runFakePhase();
  if (RUN_REAL) await runRealPhase();
  else log("EBI_E2E_APPROVAL_REAL=0 のため実 claude 部分はスキップ");

  const okCount = results.filter(Boolean).length;
  console.log(`\n==== master chat approval e2e: ${okCount}/${results.length} OK ====`);
  process.exit(okCount === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("例外:", e?.stack ?? e);
  process.exit(1);
});
