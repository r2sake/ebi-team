// master 受信の channel 化（案A）live e2e。実 claude(haiku) の master-kind 固定エビを使う。
//
// 背景: engineer 受信の notify（channel）化は e2e-notify-channel.mjs で実証済み。だが master は
// 固定エビ（FixedEbiManager 経由・config の launch そのまま）で spawn 経路が engineer と異なり、
// かつ「ボスが手入力する対話セッション」でもある。過去に master を channel 化した際「background
// job 化で入力全滅」と誤診して PTY 固定へ退避した経緯があるため、master-kind 固有で以下を実測する。
//
// 検証項目（ボス指定の核心3点＋到達確認）:
//   (a) master が起動時 dev-channels / trust ダイアログを *サーバの自動応答* で越えて正常起動し、
//       notification 購読（channel）を確立する（＝background job 化せず channel 受信可能に）。
//   (b) web UI 相当の *生の手入力*（WS {type:"input"}→PTY write）が従来どおり master に効く
//       （過去の「入力全滅」が再現しないことの反証）。
//   (c) engineer→master の reply（reverse-inject）が via:"notify"（channel）で届く＝PTY 入力欄を
//       一切経由しない。手入力とほぼ同時に発火させても via:"notify" を保つ（＝構造的に合体不能）。
//   (d) 到達確認: master が channel で受けた本文にモデルとして反応できる（end-to-end）。
//
// 安全策: 本番(8787)不可侵。専用ポート 8796＋mkdtemp 状態ディレクトリで完結。spawn した claude は
// 全て kill。master の cwd は使い捨てディレクトリ（trust ダイアログもサーバ自動応答が越える）。

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CWD_DIR = "/tmp/ebi-master-e2e-cwd";
mkdirSync(CWD_DIR, { recursive: true });

const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
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
};

/** master の制御MCP config（role=master・購読 on）。 */
function writeMasterMcp(dir) {
  const p = join(dir, "master-control.e2e.mcp.json");
  writeFileSync(p, JSON.stringify({
    mcpServers: {
      "ebi-control": {
        command: "npx",
        args: ["tsx", join(ROOT, "src/mcp/control-server.ts")],
        cwd: ROOT,
        env: {
          EBI_CONTROL_URL: `http://127.0.0.1:${PORT}`,
          EBI_MCP_ROLE: "master",
          EBI_NOTIFY_SUBSCRIBE: "on", // ← 案A の肝: master ブリッジも購読ループを回す
        },
      },
    },
  }, null, 2) + "\n");
  return p;
}

/** master-kind の固定エビ 1 体だけを持つ使い捨て config（案A の想定設定を反映）。 */
function writeConfig(dir, masterMcp) {
  const p = join(dir, "config.e2e.json");
  writeFileSync(p, JSON.stringify({
    fixedEbi: [
      {
        id: "master",
        kind: "master",
        cwd: CWD_DIR,
        model: "haiku",
        permissionMode: "auto",
        // notifySubscribe 省略＝既定 true（＝PTY 固定を解除し channel 受信を許可）。
        args: [
          "--strict-mcp-config",            // 本番 master と同じ（strict×dev-channels 共存を実地確認）
          "--mcp-config", masterMcp,
          "--dangerously-load-development-channels", "server:ebi-control", // ← 案A の肝
        ],
        appendSystemPrompt:
          "あなたはテスト用のエコー係。受け取ったメッセージ本文に「output only XXX」という指示が" +
          "含まれていたら、その XXX トークンだけを1行で返す。ツールは一切使わない。それ以外は何も書かない。",
      },
    ],
  }, null, 2) + "\n");
  return p;
}

function startServer(tmpDir, configPath) {
  const subscribed = new Set();
  const proc = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      EBI_PORT: String(PORT),
      EBI_HOST: "127.0.0.1",
      EBI_DEFAULT_CWD: CWD_DIR,
      EBI_DUMP_PATH: join(tmpDir, "registry.json"),
      EBI_CONFIG_PATH: configPath,
      EBI_READY_WAIT_MS: "90000",
      EBI_SUBSCRIBE_WAIT_MS: "90000",
      EBI_IDLE_NOTIFY: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => {
    const s = String(d);
    const m = s.match(/notification 購読が確立: id=(\S+)/);
    if (m) subscribed.add(m[1]);
    if (/起動ゲート自動応答/.test(s)) {
      for (const line of s.split("\n")) if (line.includes("起動ゲート自動応答")) gateLogs.push(line.trim());
    }
    process.stdout.write(`[srv] ${s}`);
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  return { proc, subscribed };
}

async function waitSubscribed(subscribed, id, timeoutMs) {
  const start = Date.now();
  while (!subscribed.has(id) && Date.now() - start < timeoutMs) await sleep(1000);
  return subscribed.has(id);
}

/** WS を開いて master に生の手入力を送る最小クライアント（ボスの手打ちを模す）。 */
function openWs() {
  return new Promise((resolveWs, rejectWs) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on("open", () => resolveWs(ws));
    ws.on("error", rejectWs);
  });
}
function wsSend(ws, msg) { ws.send(JSON.stringify(msg)); }
/** 1文字ずつ「タイプ」して最後に Enter（生の手入力の competing writer を再現）。 */
async function wsType(ws, id, text) {
  for (const ch of text) { wsSend(ws, { type: "input", id, data: ch }); await sleep(15); }
  wsSend(ws, { type: "input", id, data: "\r" });
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "ebi-master-e2e-"));
  console.log("tmpDir:", tmpDir, " cwd:", CWD_DIR);
  const masterMcp = writeMasterMcp(tmpDir);
  const configPath = writeConfig(tmpDir, masterMcp);
  const { proc: srv, subscribed } = startServer(tmpDir, configPath);
  let ws;

  try {
    // (a) master 起動＋購読確立（＝dialog をサーバ自動応答で越え、channel 受信可能に）
    console.log("\n--- (a) master 起動→ダイアログ自動応答→channel 購読確立 ---");
    const subA = await waitSubscribed(subscribed, "master", 120000);
    if (subA) ok("(a) master が notification 購読を確立（dev-channels/trust をサーバ自動応答で越えた）");
    else { fail("(a) master の購読が確立しない（起動 or ダイアログ自動応答 or 購読で停止）"); }
    if (gateLogs.length > 0) ok(`(a) 起動ゲート自動応答が発火（${gateLogs.length} 回）`);
    else fail("(a) 起動ゲート自動応答ログが観測されない（dialog を越えられていない可能性）");

    // master が入力受付(idle/ready)に達するまで少し待つ
    await sleep(3000);

    // (b) 生の手入力（WS→PTY write）が master に効く＝過去の「入力全滅」の反証
    console.log("\n--- (b) WS 生手入力が master に届く（web UI 手入力の反証テスト）---");
    ws = await openWs();
    wsSend(ws, { type: "subscribe", id: "master" });
    await sleep(300);
    await wsType(ws, "master", "テスト手入力です。output only ACK_WSINPUT");
    const wB = await api.waitForText("master", /ACK_WSINPUT/, 90000);
    if (wB.found) ok("(b) WS 生手入力を master が受理・応答（手入力は従来どおり機能）");
    else { fail("(b) ACK_WSINPUT 未検出＝手入力が効いていない"); console.log(wB.txt.slice(-800)); }

    // (c)+(d) engineer→master reply が via:"notify"（channel・PTY非経由）で届き、モデルが反応
    console.log("\n--- (c)(d) reverse-inject が via:notify（channel）で届く＋到達確認 ---");
    const rev = await api.post("/control/reverse-inject", {
      from: "ebi-sim", to: "master", kind: "reply",
      message: "engineer からの完了報告です。output only ACK_CHANNEL",
    });
    const via1 = rev.body?.details?.[0]?.via;
    if (rev.status === 200 && (rev.body?.delivered ?? []).includes("master")) ok("reverse-inject 受理");
    else fail("reverse-inject 失敗: " + JSON.stringify(rev));
    if (via1 === "notify") ok(`(c) reply が via:"notify"（channel）で配送＝PTY 入力欄を経由しない`);
    else fail(`(c) via が notify でない（=${via1}）＝まだ PTY 経路に落ちている`);
    const wD = await api.waitForText("master", /ACK_CHANNEL/, 90000);
    if (wD.found) ok("(d) master が channel 受信本文にモデルとして反応（end-to-end 到達）");
    else { fail("(d) ACK_CHANNEL 未検出＝channel 本文が master セッションに届いていない"); console.log(wD.txt.slice(-800)); }

    // (c-競合) 手入力とほぼ同時に reply を発火 → via:notify を保つ（構造的に合体不能）
    console.log("\n--- (c-競合) 手入力と reply の同時発火でも via:notify を維持 ---");
    const typing = wsType(ws, "master", "ボスの手入力中です。output only ACK_TYPING");
    const revC = await api.post("/control/reverse-inject", {
      from: "ebi-sim2", to: "master", kind: "reply",
      message: "競合中の完了報告です。output only ACK_CONCURRENT",
    });
    await typing;
    const via2 = revC.body?.details?.[0]?.via;
    if (via2 === "notify") ok(`(c-競合) 同時発火でも reply は via:"notify"（PTY を触らない＝手入力バッファと物理分離）`);
    else fail(`(c-競合) 同時発火で via が notify でない（=${via2}）`);
    const wT = await api.waitForText("master", /ACK_TYPING/, 90000);
    const wC = await api.waitForText("master", /ACK_CONCURRENT/, 90000);
    if (wT.found) ok("(c-競合) 手入力側トークン ACK_TYPING が master に届く");
    else { fail("(c-競合) ACK_TYPING 未検出"); }
    if (wC.found) ok("(c-競合) channel 側トークン ACK_CONCURRENT が master に届く");
    else { fail("(c-競合) ACK_CONCURRENT 未検出"); }

    await api.post("/control/kill", { id: "master" }).catch(() => {});
    await sleep(500);
  } finally {
    try { ws?.close(); } catch {}
    srv.kill("SIGTERM");
    await sleep(1500);
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("\n---- 起動ゲート自動応答ログ（発火例）----");
  for (const l of gateLogs.slice(0, 20)) console.log("  " + l);
  const okCount = results.filter(Boolean).length;
  console.log(`\n==== master channel live e2e 結果: ${okCount}/${results.length} OK（gate 自動応答 ${gateLogs.length} 回）====`);
  process.exit(okCount === results.length ? 0 : 1);
}

main().catch((e) => { console.error("例外:", e?.stack ?? e); process.exit(1); });
