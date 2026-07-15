// 逆方向通知（reverse-notify）の E2E（実課金なし）。
// EBI_COMMAND=bash + 別ポートで一時 ebi-team サーバを立て、以下を確認する:
//
//  A. 明示リプライ疎通
//     - POST /control/reverse-inject { from:"ebi-1", message:"test" }
//       → master(bash) の scrollback に `[from:ebi-1] [reply] test` が出る
//     - 自己送信（from===to）/ 宛先なし が 4xx で拒否される
//
//  B. engineer MCP のロール出し分け
//     - EBI_MCP_ROLE=engineer で control-server を起動し tools/list が
//       reply_to_master / list_ebi / read_scrollback の 3 つのみ（spawn/kill 等が出ない）
//     - reply_to_master 実行（EBI_ID 継承）→ reverse-inject 経由で master(bash) に届く
//     - 参考: master ロールでは reply_to_master が出ない・統括ツールが出る
//
//  C. idle 自動通知（B フック）＋ A 直後の抑制
//     - engineer(bash) を spawn → idle 化で `[idle] 待機に入りました…` が master に届く
//     - reverse-inject(reply) 直後の idle では [idle] が抑制される
//
//  D. 無回帰: 順方向 send_message が通る
//
// 後始末（一時サーバ/プロセス/temp config/EBI_ID env）まで行う。実 claude は使わない。

import { spawn } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const PORT = 8803;
const BASE = `http://127.0.0.1:${PORT}`;

const tmpDir = mkdtempSync(join(tmpdir(), "ebi-e2e-rev-"));
const configPath = join(tmpDir, "ebi-team.config.json");
// 固定エビ（master/supervisor）は bash で常駐させる（cat で生かす）。
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
async function masterScrollback() {
  const r = await getJson(`/control/scrollback?id=master`);
  return r.body?.data ?? "";
}

let server;
let mcpEng;
let mcpEngT;
let mcpMaster;
let mcpMasterT;
async function cleanup(code) {
  try { await mcpEng?.close(); } catch {}
  try { await mcpEngT?.close(); } catch {}
  try { await mcpMaster?.close(); } catch {}
  try { await mcpMasterT?.close(); } catch {}
  try { server?.kill("SIGTERM"); } catch {}
  await sleep(500);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

// ---- 一時サーバ起動（EBI_COMMAND=bash・別ポート・速い idle/cooldown）----
server = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    EBI_PORT: String(PORT),
    EBI_COMMAND: "bash",
    EBI_CONFIG_PATH: configPath,
    EBI_DUMP_PATH: join(tmpDir, "registry.json"),
    EBI_IDLE_MS: "300",
    EBI_MIN_BOOT_MS: "300",
    // B の抑制窓とクールダウンを小さくしてテストを速く回す。
    EBI_REPLY_SUPPRESS_MS: "1500",
    EBI_IDLE_NOTIFY_COOLDOWN_MS: "1000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
server.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));

const overall = setTimeout(() => { fail("全体タイムアウト"); finish(); }, 60000);

async function finish() {
  clearTimeout(overall);
  const okCount = results.filter(Boolean).length;
  console.log(`\n==== reverse-notify E2E 結果: ${okCount}/${results.length} OK ====`);
  await cleanup(okCount === results.length ? 0 : 1);
}

async function main() {
  // サーバ起動 + 固定エビ spawn を待つ。
  await sleep(3500);

  // ===== A. 明示リプライ疎通 =====
  console.log("\n--- A. reverse-inject（明示リプライ）---");
  {
    const r = await postJson("/control/reverse-inject", { from: "ebi-1", message: "test" });
    if (r.status === 200 && (r.body?.delivered ?? []).includes("master")) {
      ok("POST /control/reverse-inject（delivered に master）");
    } else {
      fail("reverse-inject が失敗: " + JSON.stringify(r));
    }
    await sleep(1000);
    const sb = await masterScrollback();
    if (sb.includes("[from:ebi-1] [reply] test")) {
      ok("master scrollback に `[from:ebi-1] [reply] test`");
    } else {
      fail("master に届いていない: " + sb.slice(-200));
    }
  }
  {
    const self = await postJson("/control/reverse-inject", { from: "master", to: "master", message: "x" });
    if (self.status >= 400 && /自己送信/.test(self.body?.error ?? "")) {
      ok("自己送信（from===to）が 4xx で拒否");
    } else {
      fail("自己送信が拒否されない: " + JSON.stringify(self));
    }
    const nf = await postJson("/control/reverse-inject", { from: "ebi-1", to: "nope", message: "x" });
    if (nf.status >= 400) {
      ok("宛先なしが 4xx で拒否");
    } else {
      fail("宛先なしが拒否されない: " + JSON.stringify(nf));
    }
    const bad = await postJson("/control/reverse-inject", { message: "no from" });
    if (bad.status === 400) ok("from 欠落が 400");
    else fail("from 欠落が 400 にならない: " + JSON.stringify(bad));
  }

  // ===== B. engineer MCP ロール出し分け =====
  console.log("\n--- B. engineer MCP（role=engineer）---");
  mcpEngT = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/control-server.ts"],
    cwd: root,
    // EBI_ID 継承の確認: 親 env に EBI_ID をセット → reply_to_master の from に入る。
    env: { ...process.env, EBI_CONTROL_URL: BASE, EBI_MCP_ROLE: "engineer", EBI_ID: "ebi-eng-7" },
  });
  mcpEng = new Client({ name: "e2e-eng", version: "0.0.1" });
  await mcpEng.connect(mcpEngT);
  {
    const tools = await mcpEng.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    const expected = ["list_ebi", "read_scrollback", "reply_to_master"].sort();
    const forbidden = ["spawn_engineer", "kill_engineer", "send_message", "inject_message", "set_mode", "ask_supervisor"];
    const exactMatch = names.length === expected.length && expected.every((n, i) => n === names[i]);
    const hasForbidden = forbidden.some((n) => names.includes(n));
    if (exactMatch && !hasForbidden) {
      ok(`engineer tools/list = [${names.join(", ")}]（reply_to_master + 参照系のみ）`);
    } else {
      fail("engineer tools/list が不正: " + names.join(", "));
    }
  }
  {
    const res = await mcpEng.callTool({ name: "reply_to_master", arguments: { message: "engineer done" } });
    if (!res.isError) {
      ok("reply_to_master 実行成功");
    } else {
      fail("reply_to_master 失敗: " + (res.content?.[0]?.text ?? ""));
    }
    await sleep(1000);
    const sb = await masterScrollback();
    if (sb.includes("[from:ebi-eng-7] [reply] engineer done")) {
      ok("EBI_ID 継承確認: master に `[from:ebi-eng-7] [reply] engineer done`");
    } else {
      fail("EBI_ID 継承/配送が不正: " + sb.slice(-200));
    }
  }

  // 参考: master ロールでは reply_to_master が出ない・統括ツールが出る。
  console.log("\n--- B'. master MCP（role=master・対照）---");
  mcpMasterT = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/control-server.ts"],
    cwd: root,
    env: { ...process.env, EBI_CONTROL_URL: BASE, EBI_MCP_ROLE: "master" },
  });
  mcpMaster = new Client({ name: "e2e-master", version: "0.0.1" });
  await mcpMaster.connect(mcpMasterT);
  {
    const tools = await mcpMaster.listTools();
    const names = tools.tools.map((t) => t.name);
    if (!names.includes("reply_to_master") && names.includes("spawn_engineer") && names.includes("send_message")) {
      ok(`master tools/list に reply_to_master 無し・統括ツール有り（${names.length} ツール）`);
    } else {
      fail("master tools/list が不正: " + names.join(", "));
    }
  }

  // ===== C. idle 自動通知 + A 直後の抑制 =====
  console.log("\n--- C. idle 自動通知（B）と抑制 ---");
  let engId = null;
  {
    // engineer を spawn（asEngineer:true で EBI_ID 注入。bash なので claude フラグ/MCP は付かない）。
    const r = await postJson("/control/spawn", { cwd: root, asEngineer: true });
    if (r.status === 200 && r.body?.id) {
      engId = r.body.id;
      ok(`engineer spawn（id=${engId}）`);
    } else {
      fail("engineer spawn 失敗: " + JSON.stringify(r));
    }
  }
  if (engId) {
    // ready 化（MIN_BOOT_MS 経過 + idle）してから、busy→idle のエッジを作って B を誘発する。
    // bash は起動直後すぐ idle なので、一度 inject で busy にしてから idle に戻す。
    await sleep(1500); // ready 化待ち
    // 直近に reply 履歴は無いので、idle エッジで [idle] が出るはず。
    // busy→idle エッジを作る: 短いコマンドを inject（出力後すぐ idle に戻る）。
    await postJson("/control/inject", { to: engId, message: "echo TICK" });
    await sleep(1500); // 出力 → idle へ。B 発火を待つ。
    let sb = await masterScrollback();
    if (sb.includes(`[from:${engId}] [idle] 待機に入りました`)) {
      ok(`idle 自動通知: master に \`[from:${engId}] [idle] 待機に入りました…\``);
    } else {
      fail("idle 自動通知が届かない: " + sb.slice(-300));
    }

    // 抑制テスト: クールダウン明けを待ってから reply を打ち、その直後 idle で [idle] が増えないこと。
    await sleep(1200); // cooldown(1000ms) 明け待ち
    // この時点の master 出力内の [idle] 件数を基準にする。
    const baseIdleCount = (await masterScrollback()).split(`[from:${engId}] [idle]`).length;
    // reply を打つ → from エビの lastReplyAt 更新（SUPPRESS_MS=1500ms 抑制窓に入る）。
    await postJson("/control/reverse-inject", { from: engId, message: "explicit reply" });
    // すぐに busy→idle エッジを作る（抑制窓内）。
    await postJson("/control/inject", { to: engId, message: "echo TICK2" });
    await sleep(1200); // 出力→idle（ただし SUPPRESS 窓内なので B は出ないはず）
    const afterIdleCount = (await masterScrollback()).split(`[from:${engId}] [idle]`).length;
    if (afterIdleCount === baseIdleCount) {
      ok("A（reply）直後の idle では B が抑制される（[idle] 件数が増えない）");
    } else {
      fail(`A 直後に B が抑制されていない: base=${baseIdleCount} after=${afterIdleCount}`);
    }
  }

  // ===== D. 無回帰: 順方向 send_message =====
  console.log("\n--- D. 無回帰（順方向 send_message）---");
  {
    const r = await postJson("/control/send", { to: "fwd-ebi", message: "echo FWD_OK", spawnIfMissing: true, asEngineer: true });
    if (r.status === 200 && r.body?.ok && r.body?.spawned) {
      ok(`send_message（spawnIfMissing で起動＋送信 id=${r.body.id}）`);
    } else {
      fail("send_message 失敗: " + JSON.stringify(r));
    }
    await sleep(1500);
    const sb = await getJson(`/control/scrollback?id=fwd-ebi`);
    if ((sb.body?.data ?? "").includes("FWD_OK")) {
      ok("順方向送信が対象 scrollback に反映");
    } else {
      fail("順方向送信が反映されない: " + (sb.body?.data?.slice?.(-200)));
    }
  }

  await finish();
}

main().catch(async (e) => { fail("例外: " + (e?.stack ?? e)); await finish(); });
