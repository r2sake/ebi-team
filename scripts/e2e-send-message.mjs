// send_message（統一送信）の E2E（実課金なし）。
// EBI_COMMAND=bash + 別ポートで一時 ebi-team サーバを立て、以下を確認する:
//
//  A. 制御API /control/send 単体（fetch）
//     - 未起動の宛先 + spawnIfMissing なし → ok:false, error:"not found"
//     - 未起動の宛先 + spawnIfMissing:true → bash エビが spawn され ready 待ち後に送信・実行
//       （scrollback に HELLO が出る = Enter で送信確定した証拠）
//     - 既存の宛先 + spawnIfMissing なし → ready 即時で送信され SECOND が scrollback に出る
//     - READY_WAIT を極小にして ready timeout 経路（busy で固まる command）を確認
//
//  B. 制御MCP（stdio）の send_message ツールから同等の送信を確認
//     - tools/list に send_message が出る
//     - send_message({to, message, spawnIfMissing:true}) → scrollback に MCP_SEND_OK
//
// 実 claude/engineer は使わず bash fallback で疎通確認する。後始末まで行う。
// bash は `\r` で即コマンド実行されるので「送信まで担保」できているかの良い検証になる。

import { spawn } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const PORT = 8802;
const BASE = `http://127.0.0.1:${PORT}`;

const tmpDir = mkdtempSync(join(tmpdir(), "ebi-e2e-send-"));
const configPath = join(tmpDir, "ebi-team.config.json");
// 固定エビは bash で常駐させる（殺されるまで cat で生かす）。
writeFileSync(
  configPath,
  JSON.stringify(
    {
      fixedEbi: [
        { id: "supervisor", kind: "supervisor", cwd: ".", model: "haiku", command: "bash", args: ["-c", "echo SUP_UP; exec cat"] },
        { id: "master", kind: "master", cwd: root, model: "opus", command: "bash", args: ["-c", "echo MASTER_UP; exec cat"] },
      ],
    },
    null,
    2,
  ),
);

const results = [];
const ok = (m) => { results.push(true); console.log("  OK:", m); };
const fail = (m) => { results.push(false); console.error("  NG:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let server;
let mcpClient;
let mcpTransport;
async function cleanup(code) {
  try { await mcpClient?.close(); } catch {}
  try { await mcpTransport?.close(); } catch {}
  try { server?.kill("SIGTERM"); } catch {}
  await sleep(500);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

// ---- 一時サーバ起動（EBI_COMMAND=bash・別ポート・boot 猶予を小さく）----
server = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    EBI_PORT: String(PORT),
    EBI_COMMAND: "bash",
    EBI_CONFIG_PATH: configPath,
    EBI_DUMP_PATH: join(tmpDir, "registry.json"),
    EBI_IDLE_MS: "300",
    // ready 判定の boot 猶予を小さく（bash は即 idle→ready 化できる）。
    EBI_MIN_BOOT_MS: "200",
    // ready 待ち上限。通常経路はこれで十分。timeout 経路は send 側で別途極小指定する。
    EBI_READY_WAIT_MS: "10000",
    EBI_ENTER_DELAY_MS: "200",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
server.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));

const overall = setTimeout(() => { fail("全体タイムアウト"); finish(); }, 50000);

async function finish() {
  clearTimeout(overall);
  const okCount = results.filter(Boolean).length;
  console.log(`\n==== send_message E2E 結果: ${okCount}/${results.length} OK ====`);
  await cleanup(okCount === results.length ? 0 : 1);
}

async function main() {
  // サーバ起動 + 固定エビ spawn を待つ。
  await sleep(3500);

  // ===== A. 制御API /control/send 単体 =====
  console.log("\n--- A. /control/send 単体（fetch）---");

  // A-1. 未起動 + spawnIfMissing なし → ok:false, error:"not found"
  {
    const r = await postJson("/control/send", { to: "x", message: "echo NOPE" });
    if (r.status >= 400 && r.body?.ok === false && r.body?.error === "not found") {
      ok("未起動 + spawnIfMissing なし → ok:false, error:not found");
    } else {
      fail("not found 経路が不正: " + JSON.stringify(r));
    }
  }

  // A-2. 未起動 + spawnIfMissing:true → spawn → ready 待ち → 送信・実行（HELLO）
  {
    const r = await postJson("/control/send", { to: "x", message: "echo HELLO", spawnIfMissing: true });
    if (r.status === 200 && r.body?.ok === true && r.body?.id === "x" && r.body?.spawned === true) {
      ok(`未起動→spawn→ready待ち→送信（ok:true, id=x, spawned=true, status=${r.body?.status}）`);
    } else {
      fail("spawnIfMissing 経路が不正: " + JSON.stringify(r));
    }
    // bash の `\r` で echo が実行され scrollback に HELLO が出るはず。
    await sleep(1500);
    const sb = await getJson(`/control/scrollback?id=x`);
    if (sb.status === 200 && (sb.body?.data ?? "").includes("HELLO")) {
      ok("未起動→spawn 後の echo HELLO が scrollback に出力（Enter で送信確定）");
    } else {
      fail("HELLO が scrollback に出ない: " + JSON.stringify(sb.body?.data?.slice?.(-200)));
    }
  }

  // A-3. 既存 + spawnIfMissing なし → ready 即時で送信（SECOND）
  {
    const r = await postJson("/control/send", { to: "x", message: "echo SECOND" });
    if (r.status === 200 && r.body?.ok === true && r.body?.spawned === false) {
      ok("既存→spawn せず即送信（ok:true, spawned=false）");
    } else {
      fail("既存への即送信が不正: " + JSON.stringify(r));
    }
    await sleep(1500);
    const sb = await getJson(`/control/scrollback?id=x`);
    if (sb.status === 200 && (sb.body?.data ?? "").includes("SECOND")) {
      ok("既存への echo SECOND が scrollback に出力");
    } else {
      fail("SECOND が scrollback に出ない: " + JSON.stringify(sb.body?.data?.slice?.(-200)));
    }
  }

  // 後片付け（A の動的エビ x を kill）。
  await postJson("/control/kill", { id: "x" });

  // ===== B. 制御MCP（stdio）の send_message =====
  console.log("\n--- B. 制御MCP（stdio）send_message ---");
  mcpTransport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/control-server.ts"],
    cwd: root,
    env: { ...process.env, EBI_CONTROL_URL: BASE },
  });
  mcpClient = new Client({ name: "e2e-send-client", version: "0.0.1" });
  await mcpClient.connect(mcpTransport);

  {
    const tools = await mcpClient.listTools();
    const names = tools.tools.map((t) => t.name);
    if (names.includes("send_message")) {
      ok(`tools/list に send_message が出る（計 ${names.length} ツール）`);
    } else {
      fail("tools/list に send_message が無い: " + names.join(", "));
    }
  }

  {
    const res = await mcpClient.callTool({
      name: "send_message",
      arguments: { to: "y", message: "echo MCP_SEND_OK", spawnIfMissing: true, cwd: root },
    });
    const text = res.content?.[0]?.text ?? "";
    if (!res.isError && /"ok":\s*true/.test(text) && text.includes("\"id\": \"y\"")) {
      ok("send_message（未起動 y を spawn→ready→送信）: " + text.replace(/\s+/g, " ").slice(0, 120));
    } else {
      fail("send_message が失敗: " + text);
    }
    await sleep(1500);
    const sb = await getJson(`/control/scrollback?id=y`);
    if (sb.status === 200 && (sb.body?.data ?? "").includes("MCP_SEND_OK")) {
      ok("send_message の echo MCP_SEND_OK が scrollback に出力");
    } else {
      fail("MCP_SEND_OK が scrollback に出ない: " + JSON.stringify(sb.body?.data?.slice?.(-200)));
    }
  }

  // 後片付け（B の動的エビ y を kill）。
  await postJson("/control/kill", { id: "y" });

  // ===== C. ready timeout 経路（任意・極小 READY_WAIT で確認）=====
  // 起動直後ずっと出力し続けて idle にならない command を立て、READY_WAIT を極小にして
  // ready timeout が返ることを確認する。spawnIfMissing 経路で。
  console.log("\n--- C. ready timeout 経路 ---");
  {
    // この検証用に READY_WAIT を極小化したサーバを別ポートで立てる。
    const PORT2 = 8803;
    const BASE2 = `http://127.0.0.1:${PORT2}`;
    const cfg2 = join(tmpDir, "ebi-team.timeout.config.json");
    writeFileSync(cfg2, JSON.stringify({ fixedEbi: [] }, null, 2));
    // ずっと出力し続けて idle にならない（＝ ready にならない）command を script 化する。
    // EBI_ARGS は空白 split のため複雑なワンライナーを直接渡せないので script に逃がす。
    const busyScript = join(tmpDir, "busy.sh");
    writeFileSync(busyScript, "#!/bin/bash\nwhile true; do echo BUSY; sleep 0.05; done\n", { mode: 0o755 });
    const srv2 = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
      cwd: root,
      env: {
        ...process.env,
        EBI_PORT: String(PORT2),
        // 無限に出力し続ける script を spawn の対象にする（claude フラグは付かない）。
        EBI_COMMAND: "bash",
        EBI_ARGS: busyScript,
        EBI_CONFIG_PATH: cfg2,
        EBI_DUMP_PATH: join(tmpDir, "registry2.json"),
        EBI_IDLE_MS: "300",
        EBI_MIN_BOOT_MS: "100",
        // ready 待ち上限を極小に。
        EBI_READY_WAIT_MS: "800",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    srv2.stdout.on("data", (d) => process.stdout.write("[srv2] " + d));
    srv2.stderr.on("data", (d) => process.stderr.write("[srv2-err] " + d));
    await sleep(2500);
    try {
      // 無限出力 command を spawn → idle にならない → READY_WAIT(800ms) で ready timeout。
      const r = await fetch(`${BASE2}/control/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "z", message: "echo NEVER", spawnIfMissing: true }),
      });
      const body = await r.json().catch(() => null);
      if (r.status >= 400 && body?.ok === false && body?.error === "ready timeout" && body?.spawned === true) {
        ok("ready timeout 経路（busy 維持 command → error:ready timeout, spawned:true）");
      } else {
        // timeout 経路は環境依存があるため、観測できない場合は warning 扱いにせず素直に fail。
        fail("ready timeout が観測できない: " + JSON.stringify(body));
      }
    } finally {
      try { srv2.kill("SIGTERM"); } catch {}
      await sleep(500);
    }
  }

  await finish();
}

main().catch(async (e) => { fail("例外: " + (e?.stack ?? e)); await finish(); });
