// Phase3 バッチB の E2E（実課金なし）。
// EBI_COMMAND=bash + 別ポートで一時 ebi-team サーバを立て、以下を確認する:
//
//  A. 制御API 単体（fetch）
//     - GET  /control/agents        … 固定エビ（bash master/supervisor）が一覧に出る
//     - POST /control/spawn         … 動的エビ起動 → { id }
//     - POST /control/inject        … 注入が scrollback に反映される
//     - GET  /control/scrollback    … tail でも取れる
//     - POST /control/kill (dynamic)… 削除できる
//     - POST /control/kill (pinned) … master の kill が 4xx で拒否される
//
//  B. 制御MCP（stdio）を MCP クライアント（@modelcontextprotocol/sdk）から叩く
//     - tools/list に 7 ツールが出る
//     - spawn_engineer（bash エビ起動）→ inject_message → read_scrollback に反映確認 → kill_engineer
//
// 実 claude/engineer は使わず bash fallback で疎通確認する。後始末まで行う。

import { spawn } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const PORT = 8801;
const BASE = `http://127.0.0.1:${PORT}`;

const tmpDir = mkdtempSync(join(tmpdir(), "ebi-e2e-ctrl-"));
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

// ---- 一時サーバ起動（EBI_COMMAND=bash・別ポート）----
server = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
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
});
server.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
server.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));

const overall = setTimeout(() => { fail("全体タイムアウト"); finish(); }, 40000);

async function finish() {
  clearTimeout(overall);
  const okCount = results.filter(Boolean).length;
  console.log(`\n==== バッチB E2E 結果: ${okCount}/${results.length} OK ====`);
  await cleanup(okCount === results.length ? 0 : 1);
}

async function main() {
  // サーバ起動 + 固定エビ spawn を待つ。
  await sleep(3500);

  // ===== A. 制御API 単体 =====
  console.log("\n--- A. 制御API 単体（fetch）---");
  {
    const r = await getJson("/control/agents");
    const agents = r.body?.agents ?? [];
    const master = agents.find((a) => a.id === "master");
    const sup = agents.find((a) => a.id === "supervisor");
    if (r.status === 200 && master?.kind === "master" && master?.pinned && sup?.kind === "supervisor") {
      ok(`GET /control/agents（master/supervisor が一覧に出る・計 ${agents.length} 体）`);
    } else {
      fail("GET /control/agents の内容が不正: " + JSON.stringify(r));
    }
  }

  let dynId = null;
  {
    const r = await postJson("/control/spawn", { cwd: root });
    if (r.status === 200 && r.body?.id) {
      dynId = r.body.id;
      ok(`POST /control/spawn（動的エビ起動 → id=${dynId}）`);
    } else {
      fail("POST /control/spawn が失敗: " + JSON.stringify(r));
    }
  }

  if (dynId) {
    await sleep(1200); // bash プロンプト安定待ち
    const r = await postJson("/control/inject", { to: dynId, message: "echo CTRL_INJECT_OK" });
    if (r.status === 200 && (r.body?.delivered ?? []).includes(dynId)) {
      ok("POST /control/inject（delivered に対象 id）");
    } else {
      fail("POST /control/inject が失敗: " + JSON.stringify(r));
    }
    await sleep(1000);
    const sb = await getJson(`/control/scrollback?id=${dynId}`);
    if (sb.status === 200 && (sb.body?.data ?? "").includes("CTRL_INJECT_OK")) {
      ok("GET /control/scrollback（注入が出力に反映）");
    } else {
      fail("GET /control/scrollback に反映されない: " + JSON.stringify(sb.body?.data?.slice?.(-200)));
    }
    const sbTail = await getJson(`/control/scrollback?id=${dynId}&tail=20`);
    if (sbTail.status === 200 && (sbTail.body?.data ?? "").length <= 20) {
      ok("GET /control/scrollback?tail=20（末尾 N 文字に絞れる）");
    } else {
      fail("scrollback tail が効いていない: len=" + (sbTail.body?.data?.length));
    }
  }

  {
    // pinned kill 拒否
    const r = await postJson("/control/kill", { id: "master" });
    if (r.status >= 400 && /固定エビ/.test(r.body?.error ?? "")) {
      ok("POST /control/kill（pinned=master は 4xx で拒否）");
    } else {
      fail("pinned kill が拒否されない: " + JSON.stringify(r));
    }
  }

  if (dynId) {
    const r = await postJson("/control/kill", { id: dynId });
    if (r.status === 200 && r.body?.killed) {
      ok(`POST /control/kill（dynamic ${dynId} を削除）`);
    } else {
      fail("dynamic kill 失敗: " + JSON.stringify(r));
    }
  }

  // ===== B. 制御MCP（stdio）=====
  console.log("\n--- B. 制御MCP（stdio・MCP クライアント）---");
  mcpTransport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/control-server.ts"],
    cwd: root,
    env: { ...process.env, EBI_CONTROL_URL: BASE },
  });
  mcpClient = new Client({ name: "e2e-client", version: "0.0.1" });
  await mcpClient.connect(mcpTransport);

  {
    const tools = await mcpClient.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    const expected = ["ask_supervisor", "inject_message", "kill_engineer", "list_ebi", "read_scrollback", "set_mode", "spawn_engineer"];
    if (expected.every((n) => names.includes(n))) {
      ok(`tools/list（${names.length} ツール: ${names.join(", ")}）`);
    } else {
      fail("tools/list に不足: " + names.join(", "));
    }
  }

  let mcpEngId = null;
  {
    // bash command 環境なので spawn_engineer の model=opus 等は無視される（claude フラグは付かない）。
    const res = await mcpClient.callTool({
      name: "spawn_engineer",
      arguments: { task: "echo MCP_TASK_OK", cwd: root },
    });
    const text = res.content?.[0]?.text ?? "";
    const m = text.match(/engineer (ebi-\d+)/);
    if (!res.isError && m) {
      mcpEngId = m[1];
      ok(`spawn_engineer（engineer 起動: ${mcpEngId}）`);
    } else {
      fail("spawn_engineer 失敗: " + text);
    }
  }

  if (mcpEngId) {
    // spawn_engineer は task を inject 済み。busy ならキューに積まれ idle 復帰で流れる。
    await sleep(2000);
    const res = await mcpClient.callTool({ name: "read_scrollback", arguments: { id: mcpEngId } });
    const text = res.content?.[0]?.text ?? "";
    if (text.includes("MCP_TASK_OK")) {
      ok("read_scrollback（spawn_engineer の task 注入が反映）");
    } else {
      // 念のため inject_message でもう一度送って確認する経路もテスト。
      await mcpClient.callTool({ name: "inject_message", arguments: { to: mcpEngId, message: "echo MCP_INJECT_OK" } });
      await sleep(1500);
      const res2 = await mcpClient.callTool({ name: "read_scrollback", arguments: { id: mcpEngId } });
      if ((res2.content?.[0]?.text ?? "").includes("MCP_INJECT_OK")) {
        ok("inject_message → read_scrollback（注入反映・spawn時 task は idle 待ち）");
      } else {
        fail("read_scrollback に task/inject が反映されない: " + text.slice(-200));
      }
    }
  }

  if (mcpEngId) {
    const res = await mcpClient.callTool({ name: "kill_engineer", arguments: { id: mcpEngId } });
    if (!res.isError && /killed/.test(res.content?.[0]?.text ?? "")) {
      ok(`kill_engineer（${mcpEngId} 削除）`);
    } else {
      fail("kill_engineer 失敗: " + (res.content?.[0]?.text ?? ""));
    }
  }

  {
    // pinned は kill_engineer でも拒否される。
    const res = await mcpClient.callTool({ name: "kill_engineer", arguments: { id: "supervisor" } });
    if (res.isError && /固定エビ/.test(res.content?.[0]?.text ?? "")) {
      ok("kill_engineer（pinned=supervisor は拒否）");
    } else {
      fail("kill_engineer が pinned を拒否しない: " + (res.content?.[0]?.text ?? ""));
    }
  }

  await finish();
}

main().catch(async (e) => { fail("例外: " + (e?.stack ?? e)); await finish(); });
