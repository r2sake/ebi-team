// PR-M10 受け入れ e2e: master がチャット欄へ画像を共有する（`chat_image`）。
//
// 確認すること:
//   (1) POST /control/chat-image が保管庫へコピーし、name/url が保管庫形式で返る
//   (2) 返った url が同じバイト列を配信する（GET /control/chat-attachment?name=）
//   (3) WS に chatEvent{kind:"image"} が流れる（seq が単調・base64 は載らない）
//   (4) 許可ルート外のパス / 画像でない拡張子 / 不存在は 400
//   (5) master 専用 MCP `chat_image`（stdio ブリッジ）から叩いても同じように通る
//       ＝ MCP ツール → 制御API の実配線。作業エビ（engineer ロール）には露出しない
//   (6) 偽 claude のターン内から共有できる（`img:<path>` 指令）
//   (7) サーバ再起動後も chatSnapshot に image イベントが残る（master-chat.jsonl 経由）
//   (8) chat master が居ない構成（ui:"terminal"）では open_viewer へ自動フォールバックし、
//       GET /control/viewer-file?id= が 200 を返す（ツールを失敗させない・裁定 Q-4）
//
// 実行:
//   node scripts/e2e-master-chat-share-image.mjs
//
// 枠の使い方: **実 claude を一切使わない**（偽 claude スタブ scripts/fake-claude-stream.mjs）。
//   サブスク枠も課金も消費しない。
//
// 安全条件:
//  - 稼働 control API（127.0.0.1:8787）には触らない。**専用ポート 8802 / 8803** を使う。
//  - `.ebi-team/` は読むだけ。生成物は mkdtemp 配下（EBI_VIEWER_ROOTS も temp 配下に固定）。
//  - 停止は必ず PID 指定（srv.kill）。広域 pkill はしない。

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CHAT_PORT = Number(process.env.EBI_E2E_SHARE_IMAGE_PORT ?? 8802);
const TERM_PORT = Number(process.env.EBI_E2E_SHARE_IMAGE_TERM_PORT ?? 8803);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const results = [];
const ok = (m) => { results.push(true); console.log("  OK:", m); };
const fail = (m) => { results.push(false); console.error("  NG:", m); };

// ---- 単色 PNG を作る（外部依存なし・scripts/e2e-master-chat-image.mjs と同じ実装）----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** size × size の単色 PNG（RGB8）。 */
function solidPng(size, [r, g, b]) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const off = y * (size * 3 + 1);
    raw[off] = 0;
    for (let x = 0; x < size; x++) {
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** master 1 体だけの使い捨て config。ui は呼び出し側で決める（chat / 未指定＝terminal）。 */
function writeConfig(dir, ui) {
  const p = join(dir, `config.${ui ?? "terminal"}.json`);
  const master = {
    id: "master",
    kind: "master",
    brain: "claude",
    cwd: ROOT,
    model: "haiku",
    permissionMode: "auto",
    appendSystemPrompt: "テスト用",
    ...(ui ? { ui } : { command: "bash", args: ["-c", "echo MASTER_UP; exec cat"] }),
  };
  writeFileSync(p, `${JSON.stringify({ fixedEbi: [master] }, null, 2)}\n`);
  return p;
}

/** master 用の制御MCP config。 */
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

function startServer({ port, tmpDir, configPath, masterMcp, pathPrefix, viewerRoots }) {
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
      EBI_CHAT_ATTACH_DIR: join(tmpDir, "chat-attachments"),
      EBI_VIEWERS_PATH: join(tmpDir, "viewers.json"),
      // 画像の許可ルートは temp 配下に固定する（リポジトリ外を読ませない）。
      EBI_VIEWER_ROOTS: viewerRoots,
      EBI_IDLE_NOTIFY: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  return proc;
}

async function openWs(port) {
  const ws = await new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    w.on("open", () => res(w));
    w.on("error", rej);
  });
  const state = { events: [], envelopes: [], states: [], snapshots: [] };
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "chatEvent") {
      state.events.push(msg.event);
      state.envelopes.push({ seq: msg.seq, event: msg.event });
    } else if (msg.type === "chatState") state.states.push(msg);
    else if (msg.type === "chatSnapshot") state.snapshots.push(msg);
  });
  return { ws, state };
}

async function waitEvent(state, from, pred, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    for (let i = from; i < state.envelopes.length; i++) {
      if (pred(state.envelopes[i].event)) return state.envelopes[i];
    }
    if (Date.now() >= until) return null;
    await sleep(150);
  }
}

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

async function stopServer(srv) {
  srv.kill("SIGTERM");
  await sleep(2500);
  if (srv.exitCode === null) srv.kill("SIGKILL");
}

async function postChatImage(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/control/chat-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const NAME_RE = /^chat-[0-9]{8}-[0-9]{6}-[0-9a-f]{8}\.(png|jpg|gif|webp)$/;

// ===== chat master（ui:"chat"）側 =====

async function runChatPhase() {
  const tmpDir = mkdtempSync(join(tmpdir(), "ebi-m10-chat-"));
  const workRoot = join(tmpDir, "workspace");
  mkdirSync(workRoot, { recursive: true });
  const png = solidPng(64, [10, 200, 90]);
  const shotPath = join(workRoot, "shot.png");
  writeFileSync(shotPath, png);
  const secondPath = join(workRoot, "second.png");
  writeFileSync(secondPath, solidPng(48, [200, 40, 40]));
  const notePath = join(workRoot, "note.md");
  writeFileSync(notePath, "# これは画像ではない\n");
  // 許可ルートの外に置いた PNG（400 になるべきもの）。
  const outsidePath = join(tmpDir, "outside.png");
  writeFileSync(outsidePath, png);

  log(`[chat] tmpDir: ${tmpDir} / port ${CHAT_PORT}`);
  const configPath = writeConfig(tmpDir, "chat");
  const masterMcp = writeMasterMcp(tmpDir, CHAT_PORT);
  const binDir = writeFakeClaude(tmpDir);
  let srv = startServer({
    port: CHAT_PORT,
    tmpDir,
    configPath,
    masterMcp,
    pathPrefix: binDir,
    viewerRoots: workRoot,
  });
  let client = null;
  let mcp = null;

  try {
    await sleep(3500);
    client = await openWs(CHAT_PORT);
    const { state } = client;
    if (await waitState(state, (s) => s.state === "idle", 60_000)) {
      ok("[chat] master（chat）が idle になった");
    } else {
      return fail("[chat] master（chat）が idle にならない");
    }

    // ---- (1)(2)(3) 共有 → 保管庫コピー → 配信 → WS イベント ----
    let from = state.envelopes.length;
    const shared = await postChatImage(CHAT_PORT, {
      path: shotPath,
      title: "生成サンプル",
      caption: "e2e で共有した緑の PNG",
    });
    if (
      shared.status === 200 &&
      shared.body?.shown === "chat" &&
      NAME_RE.test(shared.body?.name ?? "") &&
      shared.body?.sourcePath === shotPath
    ) {
      ok(`[chat] chat-image が 200・保管庫形式の name を返す（${shared.body.name}）`);
    } else {
      fail(`[chat] chat-image の応答が期待の形でない: ${JSON.stringify(shared)}`);
    }

    const dl = await fetch(`http://127.0.0.1:${CHAT_PORT}${shared.body?.url ?? ""}`);
    const got = Buffer.from(await dl.arrayBuffer());
    if (dl.status === 200 && dl.headers.get("content-type") === "image/png" && got.equals(png)) {
      ok("[chat] 返った url が同じバイト列を配信する（既存 chat-attachment 経路の流用）");
    } else {
      fail(`[chat] 画像配信が一致しない（status=${dl.status} bytes=${got.length}/${png.length}）`);
    }

    const evt = await waitEvent(state, from, (e) => e.kind === "image", 20_000);
    const image = evt?.event.images?.[0];
    if (image?.name === shared.body?.name && image?.title === "生成サンプル") {
      ok("[chat] WS に chatEvent{kind:'image'} が流れる（title/caption 付き）");
    } else {
      fail(`[chat] image イベントが出ない: ${JSON.stringify(evt?.event ?? null)}`);
    }
    if (!JSON.stringify(evt?.event ?? {}).includes("base64")) {
      ok("[chat] イベントに base64 は載らない（JSONL 肥大なし）");
    } else {
      fail("[chat] イベントに base64 が載っている");
    }
    const seqs = state.envelopes.map((e) => e.seq);
    if (seqs.every((v, i) => i === 0 || v > seqs[i - 1])) ok("[chat] seq が単調増加している");
    else fail(`[chat] seq が単調でない: ${seqs.join(",")}`);

    // ---- (4) 許可ルート外 / 非画像 / 不存在は 400 ----
    const outside = await postChatImage(CHAT_PORT, { path: outsidePath });
    if (outside.status === 400 && /許可ルート外/.test(outside.body?.error ?? "")) {
      ok("[chat] 許可ルート外のパスは 400（EBI_VIEWER_ROOTS 配下のみ）");
    } else {
      fail(`[chat] 許可ルート外が 400 にならない: ${JSON.stringify(outside)}`);
    }
    const md = await postChatImage(CHAT_PORT, { path: notePath });
    if (md.status === 400 && /画像ファイルではありません/.test(md.body?.error ?? "")) {
      ok("[chat] .md は 400（画像だけを共有できる）");
    } else {
      fail(`[chat] .md が 400 にならない: ${JSON.stringify(md)}`);
    }
    const missing = await postChatImage(CHAT_PORT, { path: join(workRoot, "nope.png") });
    if (missing.status === 400) ok("[chat] 存在しないパスは 400");
    else fail(`[chat] 不存在が 400 にならない: ${JSON.stringify(missing)}`);

    // ---- (5) master 専用 MCP `chat_image`（stdio ブリッジ）の実配線 ----
    mcp = new Client({ name: "e2e-m10", version: "0.1.0" }, { capabilities: {} });
    await mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", join(ROOT, "src/mcp/control-server.ts")],
        cwd: ROOT,
        env: {
          ...process.env,
          EBI_CONTROL_URL: `http://127.0.0.1:${CHAT_PORT}`,
          EBI_MCP_ROLE: "master",
          EBI_NOTIFY_SUBSCRIBE: "off",
        },
      }),
    );
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    if (tools.includes("chat_image")) ok("[chat] master ロールの MCP に chat_image が出る");
    else fail(`[chat] chat_image が tools/list に無い: ${tools.join(", ")}`);

    from = state.envelopes.length;
    const called = await mcp.callTool({
      name: "chat_image",
      arguments: { path: secondPath, title: "MCP 経由", caption: "ブリッジの実配線" },
    });
    const calledText = called.content?.[0]?.text ?? "";
    const viaMcp = await waitEvent(
      state,
      from,
      (e) => e.kind === "image" && e.images?.[0]?.title === "MCP 経由",
      20_000,
    );
    if (!called.isError && /"shown": "chat"/.test(calledText) && viaMcp) {
      ok("[chat] MCP `chat_image` → 制御API → チャットまで通る");
    } else {
      fail(`[chat] MCP 経由の共有が通らない: ${calledText.slice(0, 200)}`);
    }
    const rejectedByMcp = await mcp.callTool({ name: "chat_image", arguments: { path: outsidePath } });
    if (rejectedByMcp.isError && /許可ルート外/.test(rejectedByMcp.content?.[0]?.text ?? "")) {
      ok("[chat] MCP 経由でも許可ルート外は拒否される");
    } else {
      fail("[chat] MCP 経由で許可ルート外が通ってしまった");
    }
    await mcp.close();
    mcp = null;

    // ---- (6) 偽 claude のターン内から共有する（`img:` 指令）----
    from = state.envelopes.length;
    client.ws.send(JSON.stringify({ type: "chatSend", id: "master", text: `img:${shotPath}` }));
    const inTurn = await waitEvent(
      state,
      from,
      (e) => e.kind === "image" && e.images?.[0]?.title === "偽 claude の共有",
      30_000,
    );
    const turnEnd = await waitEvent(state, from, (e) => e.kind === "turnEnd" && e.ok, 30_000);
    if (inTurn && turnEnd) ok("[chat] ターンの途中で共有してもターンは完走する");
    else fail(`[chat] ターン内共有が成立しない（image=${!!inTurn} turnEnd=${!!turnEnd}）`);

    // ---- (7) サーバ再起動後も snapshot に残る ----
    await sleep(1000); // JSONL の書き込みが落ち着くのを待つ。
    client.ws.close();
    client = null;
    await stopServer(srv);
    srv = startServer({
      port: CHAT_PORT,
      tmpDir,
      configPath,
      masterMcp,
      pathPrefix: binDir,
      viewerRoots: workRoot,
    });
    await sleep(4000);
    client = await openWs(CHAT_PORT);
    await waitState(client.state, (s) => s.state === "idle", 60_000);
    const snap = client.state.snapshots[0];
    const restored = (snap?.events ?? []).filter((e) => e.event.kind === "image");
    if (restored.length >= 3) {
      ok(`[chat] 再起動後の chatSnapshot に image イベントが残る（${restored.length} 件）`);
    } else {
      fail(`[chat] 再起動後に image イベントが復元されない（${restored.length} 件）`);
    }
    // 保管庫の実体も残っている＝履歴の画像がそのまま出る。
    const again = await fetch(
      `http://127.0.0.1:${CHAT_PORT}${restored[0]?.event.images?.[0]?.url ?? ""}`,
    );
    if (again.status === 200) ok("[chat] 再起動後も保管庫の画像が配信できる");
    else fail(`[chat] 再起動後に画像が配信できない（status=${again.status}）`);
  } finally {
    try {
      await mcp?.close();
    } catch {}
    try {
      client?.ws.close();
    } catch {}
    await stopServer(srv);
    log(`[chat] 会話ログ: ${join(tmpDir, "master-chat.jsonl")}（tmpDir は残す）`);
  }
}

// ===== terminal master（ui 未指定）側: open_viewer フォールバック =====

async function runTerminalPhase() {
  const tmpDir = mkdtempSync(join(tmpdir(), "ebi-m10-term-"));
  const workRoot = join(tmpDir, "workspace");
  mkdirSync(workRoot, { recursive: true });
  const png = solidPng(32, [30, 60, 220]);
  const shotPath = join(workRoot, "shot.png");
  writeFileSync(shotPath, png);
  log(`[term] tmpDir: ${tmpDir} / port ${TERM_PORT}`);
  const configPath = writeConfig(tmpDir, null); // ui 未指定＝ terminal（PTY / bash スタブ）
  const masterMcp = writeMasterMcp(tmpDir, TERM_PORT);
  const srv = startServer({
    port: TERM_PORT,
    tmpDir,
    configPath,
    masterMcp,
    pathPrefix: null,
    viewerRoots: workRoot,
  });

  try {
    await sleep(3500);
    const shared = await postChatImage(TERM_PORT, { path: shotPath, title: "terminal でも失敗しない" });
    if (shared.status === 200 && shared.body?.shown === "viewer" && shared.body?.id) {
      ok(`[term] chat master が居なくても 200 で viewer フォールバックする（${shared.body.id}）`);
    } else {
      fail(`[term] viewer フォールバックが効かない: ${JSON.stringify(shared)}`);
      return;
    }
    const file = await fetch(
      `http://127.0.0.1:${TERM_PORT}/control/viewer-file?id=${encodeURIComponent(shared.body.id)}`,
    );
    const bytes = Buffer.from(await file.arrayBuffer());
    if (file.status === 200 && bytes.equals(png)) {
      ok("[term] フォールバックで開いた viewer から画像が配信できる");
    } else {
      fail(`[term] viewer-file が期待どおりでない（status=${file.status}）`);
    }
    // チャット添付の口（＝外から保管庫へ書ける口）は terminal 構成では従来どおり塞がったまま。
    // 実装上は index.ts の saveChatAttachment が throw して 400 になる（404 ではない）。
    const attach = await fetch(`http://127.0.0.1:${TERM_PORT}/control/chat-attach`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: png,
    });
    const attachErr = (await attach.json().catch(() => null))?.error ?? "";
    if (attach.status >= 400 && /chat/.test(attachErr)) {
      ok(`[term] chat-attach は terminal 構成では従来どおり塞がったまま（${attach.status}）`);
    } else {
      fail(`[term] chat-attach が塞がっていない（status=${attach.status} ${attachErr}）`);
    }

    const outside = await postChatImage(TERM_PORT, { path: join(tmpDir, "nope.png") });
    if (outside.status === 400) ok("[term] フォールバック側でも不正パスは 400");
    else fail(`[term] フォールバック側の不正パスが 400 でない: ${JSON.stringify(outside)}`);
  } finally {
    await stopServer(srv);
    log(`[term] viewers.json: ${join(tmpDir, "viewers.json")}（tmpDir は残す）`);
  }
}

async function main() {
  await runChatPhase();
  await runTerminalPhase();
  const okCount = results.filter(Boolean).length;
  console.log(`\n==== master chat share-image e2e: ${okCount}/${results.length} OK ====`);
  process.exit(okCount === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("例外:", e?.stack ?? e);
  process.exit(1);
});
