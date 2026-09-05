// PR-M0 PoC（codex 版）: master を codex app-server（JSON-RPC・stdio）で常駐させられるかの実測。
//
// 設計書: docs/design/master-chat-ui-2026-09-05.md §1.2 / §9 PR-M0 の④。
// ボス裁定 Q-1「codex も master 頭脳の対象に入れる（規約グレーは docs に明記・既定は claude）」を受けた確認。
//
// 使い方: node scripts/poc-master-headless-codex.mjs
// 稼働 control API（8787）には触らない。偽 control API（既定 9912）を別ポートで立てる。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { toCodexConfigArgs, toCodexProjectsTrustArgs } from "../src/server/backends/mcpSpec.ts";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = process.env.POC_OUT ?? join(ROOT, "tmp", "poc-m0-codex");
const FAKE_PORT = Number(process.env.POC_CONTROL_PORT ?? 9912);
mkdirSync(OUT, { recursive: true });
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  appendFileSync(join(OUT, "poc.log"), line + "\n");
};

const fakeSrc = `
import { createServer } from "node:http";
createServer((req, res) => {
  let body = ""; req.on("data", c => body += c);
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    console.log("HIT " + req.method + " " + url.pathname + url.search + " " + body.slice(0,200));
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/control/agents") res.end(JSON.stringify({ agents: [
      { id: "master", kind: "fixed", status: "busy" },
      { id: "poc-engineer-1", kind: "dynamic", status: "idle", branch: "ebi/poc" }] }));
    else if (url.pathname === "/control/scrollback") res.end(JSON.stringify({ data: "POC-SCROLLBACK-MARKER-7391" }));
    else if (url.pathname === "/control/reverse-inject") res.end(JSON.stringify({ ok: true }));
    else { res.statusCode = 404; res.end(JSON.stringify({ error: "not found" })); }
  });
}).listen(${FAKE_PORT}, "127.0.0.1", () => console.log("listening ${FAKE_PORT}"));
`;
writeFileSync(join(OUT, "fake-control.mjs"), fakeSrc);
const fake = spawn(process.execPath, [join(OUT, "fake-control.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
const fakeHits = [];
fake.stdout.on("data", (d) => {
  for (const l of String(d).trim().split("\n")) if (l.startsWith("HIT ")) fakeHits.push(l);
  log(`fake-control> ${String(d).trim()}`);
});

const controlMcp = {
  name: "ebi-control",
  command: join(ROOT, "node_modules/.bin/tsx"),
  args: [join(ROOT, "src/mcp/control-server.ts")],
  cwd: ROOT,
  env: { EBI_CONTROL_URL: `http://127.0.0.1:${FAKE_PORT}`, EBI_MCP_ROLE: "master" },
};

// サブスク（ChatGPT ログイン）経路の固定: API キー系 env を機械的に落とす。
function codexEnv() {
  const e = { ...process.env };
  for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY"]) delete e[k];
  return e;
}

function spawnAppServer(tag) {
  const args = [
    ...toCodexProjectsTrustArgs([ROOT]),
    ...toCodexConfigArgs(controlMcp, { startupTimeoutSec: 60 }),
    "app-server",
  ];
  log(`spawn codex ${args.join(" ")}`);
  const p = spawn("codex", args, { cwd: ROOT, env: codexEnv(), stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  const waiters = [];
  let id = 0;
  createInterface({ input: p.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    appendFileSync(join(OUT, `${tag}.ndjson`), line + "\n");
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    events.push(ev);
    for (const w of [...waiters]) if (w.match(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
  });
  p.stderr.on("data", (d) => appendFileSync(join(OUT, `${tag}.stderr.log`), String(d)));
  p.on("exit", (c, s) => log(`[${tag}] exit code=${c} sig=${s}`));
  const api = {
    proc: p,
    events,
    notify(method, params) { p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); },
    wait(match, ms = 240000, what = "event") {
      for (const ev of events) if (match(ev)) return Promise.resolve(ev);
      return new Promise((res, rej) => {
        const w = { match, resolve: res };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error(`timeout waiting ${what}`)); } }, ms);
      });
    },
    async call(method, params, ms = 240000) {
      const rid = ++id;
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
      const res = await api.wait((e) => e.id === rid, ms, method);
      if (res.error) throw new Error(`${method} error: ${JSON.stringify(res.error)}`);
      return res.result;
    },
  };
  return api;
}

/**
 * **実測**: `thread/tokenUsage/updated` の `tokenUsage.total` は**スレッド累計の積算**で、
 * 文脈占有量ではない（claude の result.usage と同じ罠）。文脈占有量は `tokenUsage.last.inputTokens`。
 */
export function codexContextTokens(tokenUsage) {
  const last = tokenUsage?.last;
  if (!last) return null;
  return last.inputTokens ?? null;
}

const findings = {};

async function runTurn(c, threadId, text, label, ms = 300000) {
  const before = c.events.length;
  const p = c.call("turn/start", { threadId, input: [{ type: "text", text }] }, ms);
  const completed = await c.wait((e) => e.method === "turn/completed" && c.events.indexOf(e) >= before, ms, `turn/completed(${label})`);
  await p.catch(() => {});
  return summarizeTurn(c, before, completed, label);
}

/**
 * 1 ターン分のイベント列を集計する。実測の形:
 *   item は `item.type`（userMessage / reasoning / agentMessage / mcpToolCall …）。`item_type` ではない。
 *   最終回答は `agentMessage` かつ `phase === "final_answer"`（途中経過は phase="commentary"）。
 *   usage は `thread/tokenUsage/updated`、枠は `account/rateLimits/updated` で**別イベントとして**流れる。
 */
function summarizeTurn(c, before, completed, label) {
  const seg = c.events.slice(before);
  const items = seg.filter((e) => e.method === "item/completed").map((e) => e.params.item);
  const text = items.filter((i) => i.type === "agentMessage" && i.phase === "final_answer").map((i) => i.text).join("\n");
  const mcpCalls = items.filter((i) => i.type === "mcpToolCall");
  const tools = mcpCalls.map((i) => `${i.server ?? "?"}.${i.tool ?? "?"}`);
  // 偽 control API 側の stdout はプロセス強制終了で欠けることがあるので、
  // 「本当に制御MCP を経由したか」の一次証拠は mcpToolCall の result から取る。
  const toolResults = mcpCalls.map((i) => (i.result?.content ?? []).map((c) => c.text).join("").slice(0, 300));
  const tokenUsage = [...seg].reverse().find((e) => e.method === "thread/tokenUsage/updated")?.params?.tokenUsage;
  const rl = [...seg].reverse().find((e) => e.method === "account/rateLimits/updated")?.params?.rateLimits;
  const rec = {
    text: text.slice(0, 500),
    itemTypes: [...new Set(items.map((i) => i.type))],
    tools,
    toolResults,
    contextTokens: codexContextTokens(tokenUsage),
    cumulativeTokens: tokenUsage?.total?.totalTokens ?? null,
    rateLimits: rl ? { primary: rl.primary, secondary: rl.secondary, planType: rl.planType ?? null } : null,
    status: completed.params?.turn?.status,
  };
  log(`[${label}] items=${JSON.stringify(rec.itemTypes)} tools=${JSON.stringify(rec.tools)} ctx=${rec.contextTokens} cumulative=${rec.cumulativeTokens} status=${rec.status}`);
  log(`[${label}] rateLimits=${JSON.stringify(rec.rateLimits)}`);
  if (toolResults.length) log(`[${label}] toolResults=${JSON.stringify(toolResults)}`);
  log(`[${label}] ${rec.text}`);
  return rec;
}

async function main() {
  const c = spawnAppServer("codex1");
  const initRes = await c.call("initialize", { clientInfo: { name: "ebi-team-master-poc", title: "ebi-team", version: "0.0.1" } }, 60000);
  c.notify("initialized", {});
  findings.initialize = initRes;
  log(`initialize: ${JSON.stringify(initRes)}`);

  const started = await c.call("thread/start", {}, 120000);
  const threadId = started.thread.id;
  findings.threadStart = { threadId, model: started.model, modelProvider: started.modelProvider, path: started.thread.path };
  log(`thread/start: id=${threadId} model=${started.model}`);

  // MCP サーバの起動状態
  try {
    const mcpStatus = await c.call("mcpServerStatus/list", { threadId }, 90000);
    // tools 定義そのものは巨大なので、サーバ名とツール名だけに畳む。
    findings.mcpServerStatus = (mcpStatus.data ?? []).map((s) => ({ name: s.name, tools: Object.keys(s.tools ?? {}) }));
    log(`mcpServerStatus/list: ${findings.mcpServerStatus.map((s) => `${s.name}(${s.tools.length})`).join(", ")}`);
    log(`ebi-control tools: ${JSON.stringify(findings.mcpServerStatus.find((s) => s.name === "ebi-control")?.tools)}`);
  } catch (e) {
    findings.mcpServerStatus = { error: String(e) };
    const notif = c.events.filter((e) => e.method === "mcpServer/startupStatus/updated").map((e) => e.params);
    findings.mcpStartupNotifications = notif;
    log(`mcpServerStatus/list 不可: ${e} / 通知=${JSON.stringify(notif)}`);
  }

  findings.turn1 = await runTurn(c, threadId, "PoC ターン1。合言葉『ウニ-4127』を覚えてください。覚えたと一言だけ日本語で返答してください。", "turn1");
  findings.turn2 = await runTurn(c, threadId, "PoC ターン2。さっきの合言葉をそのまま繰り返してください。", "turn2");
  findings.turn2.remembered = findings.turn2.text.includes("ウニ-4127");

  // MCP ツール実呼び出し + 走行中の追加投入（turn/steer）
  const before = c.events.length;
  const turnP = c.call("turn/start", { threadId, input: [{ type: "text", text: "ebi-control の list_ebi ツールを実行して、返ってきたエビ id を列挙してください。" }] }, 300000);
  // turn/steer は走行中ターンの id が要る（実測: expectedTurnId 必須）。
  const startedEv = await c.wait((e) => e.method === "turn/started" && c.events.indexOf(e) >= before, 60000, "turn/started(turn3)");
  const runningTurnId = startedEv.params.turn.id;
  await new Promise((r) => setTimeout(r, 2000));
  try {
    await c.call("turn/steer", {
      threadId,
      expectedTurnId: runningTurnId,
      input: [{ type: "text", text: "[from:poc-engineer-1] PoC 割り込み。合言葉『イクラ-9053』も覚えてください。" }],
    }, 60000);
    findings.steer = { ok: true, expectedTurnId: runningTurnId };
  } catch (e) {
    findings.steer = { ok: false, error: String(e) };
  }
  log(`turn/steer: ${JSON.stringify(findings.steer)}`);
  const completed3 = await c.wait((e) => e.method === "turn/completed" && c.events.indexOf(e) >= before, 300000, "turn/completed(turn3)");
  await turnP.catch(() => {});
  findings.turn3 = summarizeTurn(c, before, completed3, "turn3");
  findings.turn3.fakeControlHits = fakeHits.filter((h) => !h.includes("/control/subscribe"));
  log(`[turn3] hits=${JSON.stringify(findings.turn3.fakeControlHits)}`);

  findings.turn4 = await runTurn(c, threadId, "さっき覚えてもらった合言葉を 2 つとも列挙してください。", "turn4");
  findings.steerConsumed = findings.turn4.text.includes("ウニ-4127") && findings.turn4.text.includes("イクラ-9053");
  log(`steerConsumed=${findings.steerConsumed}`);

  // プロセス強制終了 → thread/resume
  log(`SIGKILL codex1 pid=${c.proc.pid}`);
  c.proc.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 2500));

  const c2 = spawnAppServer("codex2");
  await c2.call("initialize", { clientInfo: { name: "ebi-team-master-poc", title: "ebi-team", version: "0.0.1" } }, 60000);
  c2.notify("initialized", {});
  try {
    const resumed = await c2.call("thread/resume", { threadId }, 120000);
    const rec = await runTurn(c2, resumed.thread?.id ?? threadId, "復帰確認。覚えている合言葉を 2 つとも列挙してください。", "resume");
    findings.resume = {
      ok: true,
      sameThread: (resumed.thread?.id ?? threadId) === threadId,
      both: rec.text.includes("ウニ-4127") && rec.text.includes("イクラ-9053"),
      text: rec.text,
      contextTokens: rec.contextTokens,
    };
  } catch (e) {
    findings.resume = { ok: false, error: String(e) };
  }
  log(`resume: ${JSON.stringify(findings.resume)}`);
  c2.proc.kill("SIGKILL");

  writeFileSync(join(OUT, "findings.json"), JSON.stringify(findings, null, 2) + "\n");
  log(`findings -> ${join(OUT, "findings.json")}`);
}

main()
  .catch((e) => { log(`FAILED: ${e.stack ?? e}`); writeFileSync(join(OUT, "findings.json"), JSON.stringify({ ...findings, error: String(e) }, null, 2) + "\n"); process.exitCode = 1; })
  .finally(() => { fake.kill("SIGTERM"); setTimeout(() => process.exit(process.exitCode ?? 0), 800); });
