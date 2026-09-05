// PR-M0 PoC: master をヘッドレス claude（-p + stream-json 双方向）で常駐させられるかの実測スクリプト。
//
// 設計書: docs/design/master-chat-ui-2026-09-05.md（ブランチ ebi/ebiteam-master-chat-ui-design）§9 PR-M0
// 使い捨て。本体（src/）は一切変更しない。稼働中の control API（8787）には触らず、
// 偽 control API（既定 9911）を別ポートで立てて MCP 経路だけを確かめる。
//
// 使い方:
//   node scripts/poc-master-headless.mjs                 # 全ステップ
//   POC_OUT=/path/to/logdir node scripts/poc-master-headless.mjs
//
// 確認項目（設計書の最大リスク①②）:
//   1 多ターン往復 / 2 replay ACK / 3 busy 中の追加投入キュー / 4 system.init の mcp_servers
//   5 MCP ツール実呼び出し / 6 result.usage → 文脈使用率 / 7 SIGKILL → --resume 復帰
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = process.env.POC_OUT ?? join(ROOT, "tmp", "poc-m0");
const FAKE_PORT = Number(process.env.POC_CONTROL_PORT ?? 9911);
mkdirSync(OUT, { recursive: true });

const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  appendFileSync(join(OUT, "poc.log"), line + "\n");
};

// ---- 偽 control API（別ポート・読み取り専用モック）----
const fakeSrc = `
import { createServer } from "node:http";
const hits = [];
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

const mcpConfigPath = join(OUT, "poc-master.mcp.json");
writeFileSync(
  mcpConfigPath,
  JSON.stringify(
    {
      mcpServers: {
        "ebi-control": {
          command: join(ROOT, "node_modules/.bin/tsx"),
          args: [join(ROOT, "src/mcp/control-server.ts")],
          cwd: ROOT,
          env: { EBI_CONTROL_URL: `http://127.0.0.1:${FAKE_PORT}`, EBI_MCP_ROLE: "master" },
        },
      },
    },
    null,
    2,
  ) + "\n",
);

const fake = spawn(process.execPath, [join(OUT, "fake-control.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
const fakeHits = [];
fake.stdout.on("data", (d) => {
  const s = String(d).trim();
  for (const l of s.split("\n")) if (l.startsWith("HIT ")) fakeHits.push(l);
  log(`fake-control> ${s}`);
});
log(`fake-control pid=${fake.pid} port=${FAKE_PORT}`);

// ---- master 相当の claude ヘッドレスプロセス ----
const MASTER_PROMPT =
  "あなたは ebi-team の master（PM エビ）です。日本語で、簡潔に答えてください。";

// env から API キー系を機械的に落とす（サブスク OAuth 経路の固定＝設計書 §1.1）
function masterEnv() {
  const e = { ...process.env };
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) delete e[k];
  return e;
}

function baseArgs() {
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--mcp-config", mcpConfigPath,
    "--strict-mcp-config",
    "--permission-mode", "auto",
    "--append-system-prompt", MASTER_PROMPT,
  ];
}

function spawnMaster(extraArgs, tag) {
  const args = [...baseArgs(), ...extraArgs];
  log(`spawn claude ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
  const p = spawn("claude", args, { cwd: ROOT, env: masterEnv(), stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  const waiters = [];
  const rl = createInterface({ input: p.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    appendFileSync(join(OUT, `${tag}.ndjson`), line + "\n");
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    events.push(ev);
    for (const w of [...waiters]) {
      if (w.match(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
    }
  });
  p.stderr.on("data", (d) => appendFileSync(join(OUT, `${tag}.stderr.log`), String(d)));
  p.on("exit", (code, sig) => log(`[${tag}] exit code=${code} sig=${sig}`));
  return {
    proc: p,
    events,
    send(text) {
      const msg = { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
      p.stdin.write(JSON.stringify(msg) + "\n");
      return msg;
    },
    wait(match, ms = 180000, what = "event") {
      for (const ev of events) if (match(ev)) return Promise.resolve(ev);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timeout waiting ${what}`)); }
        }, ms);
      });
    },
  };
}

const findings = {};
const textOf = (ev) => {
  const c = ev?.message?.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("") : "";
};

/**
 * **実測で判明した最重要点**: `result.usage` は「そのターンで発行した API リクエストの合計」で、
 * 文脈の占有量ではない（ツール往復が増えると 26k → 80k のように水増しされ、次ターンで戻る）。
 * 文脈占有量は **そのターン最後の assistant イベントの `message.usage`** の
 * input + cache_read + cache_creation で取る（セッション内で単調増加する）。
 */
export function contextTokensFromAssistant(assistantEvent) {
  const u = assistantEvent?.message?.usage;
  if (!u) return null;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

export function pctOf(tokens, windowTokens) {
  if (tokens == null || !windowTokens) return null;
  return { usedTokens: tokens, windowTokens, pct: Math.round((tokens / windowTokens) * 1000) / 10 };
}

/**
 * 文脈窓のサイズは `result.modelUsage[<model>].contextWindow` から取れる（実測）。
 * statusLine の `context_window_size` の代替はこれ。決め打ち定数を持つ必要はない。
 */
export function contextWindowFromResult(result) {
  const mu = result?.modelUsage;
  if (!mu) return null;
  const entries = Object.values(mu);
  return entries.length ? (entries[0].contextWindow ?? null) : null;
}

/** 比較用: result.usage をそのまま使った場合（＝誤った読み方）の値。 */
export function contextPctFromResult(result) {
  const u = result?.usage;
  if (!u) return null;
  const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return pctOf(used, contextWindowFromResult(result));
}

async function main() {
  const m = spawnMaster(["--model", "opus"], "run1");

  // 実測: stream-json 入力モードでは **最初の user メッセージを受け取るまで system/init は出ない**
  // （起動直後に出るのは SessionStart hook の system イベントだけ）。init 待ちで先にブロックすると詰まる。
  const t0 = Date.now();
  m.send("PoC ターン1。合言葉『ウニ-4127』を覚えてください。覚えたと一言だけ返答してください。");

  // ---- 4) system/init に ebi-control が載るか ----
  const init = await m.wait((e) => e.type === "system" && e.subtype === "init", 120000, "system.init");
  const sessionId = init.session_id;
  findings.init = {
    session_id: sessionId,
    model: init.model,
    permissionMode: init.permissionMode,
    mcp_servers: init.mcp_servers,
    apiKeySource: init.apiKeySource,
    capabilities: init.capabilities,
    claude_code_version: init.claude_code_version,
    tools_ebi: (init.tools ?? []).filter((t) => String(t).includes("ebi-control")),
    hookEventsBeforeInit: m.events.filter((e) => e.type === "system" && String(e.subtype).startsWith("hook_")).length,
  };
  log(`init: session=${sessionId} model=${init.model} apiKeySource=${init.apiKeySource} mcp=${JSON.stringify(init.mcp_servers)}`);
  log(`init: capabilities=${JSON.stringify(init.capabilities)}`);
  log(`init: ebi-control tools = ${JSON.stringify(findings.init.tools_ebi)}`);

  // ---- 2) replay ACK ----
  const replay1 = await m.wait((e) => e.type === "user" && textOf(e).includes("ウニ-4127"), 60000, "replay(user turn1)");
  findings.replayAck = {
    seen: true,
    latencyMs: Date.now() - t0,
    shape: { type: replay1.type, session_id: replay1.session_id, has_uuid: !!replay1.uuid },
  };

  /** 1 ターン分を投げて result まで待ち、文脈占有量も取る。 */
  async function turn(text, label, waitMs = 240000) {
    const from = m.events.length;
    if (text !== null) m.send(text);
    const r = await m.wait((e) => e.type === "result" && m.events.indexOf(e) >= from, waitMs, `result(${label})`);
    const seg = m.events.slice(from, m.events.indexOf(r) + 1);
    const lastAssistant = [...seg].reverse().find((e) => e.type === "assistant" && e.message?.usage);
    const rec = {
      text: String(r.result ?? "").slice(0, 300),
      subtype: r.subtype,
      num_turns: r.num_turns,
      queued_turn_count: r.queued_turn_count,
      durationMs: r.duration_ms,
      cumulativeCostUsd: r.total_cost_usd,
      resultUsageSum: contextPctFromResult(r),
      contextWindow: contextWindowFromResult(r),
      contextFromLastAssistant: pctOf(contextTokensFromAssistant(lastAssistant), contextWindowFromResult(r)),
      toolCalls: seg
        .filter((e) => e.type === "assistant")
        .flatMap((e) => (e.message?.content ?? []).filter((b) => b.type === "tool_use").map((b) => b.name)),
    };
    log(`[${label}] ctx=${JSON.stringify(rec.contextFromLastAssistant)} resultUsageSum=${JSON.stringify(rec.resultUsageSum)} cost=${rec.cumulativeCostUsd} queued=${rec.queued_turn_count} tools=${JSON.stringify(rec.toolCalls)}`);
    log(`[${label}] ${rec.text}`);
    return { r, rec, seg };
  }

  // turn1 の result（既に送信済みなので text=null）
  const t1 = await turn(null, "turn1");
  findings.turn1 = t1.rec;

  // ---- 1') 多ターン継続（記憶が繋がるか）----
  const t2 = await turn("PoC ターン2。さっきの合言葉をそのまま繰り返してください。", "turn2");
  findings.turn2 = { ...t2.rec, remembered: t2.rec.text.includes("ウニ-4127") };

  // ---- 5) MCP ツール実呼び出し + 3) busy 中の追加投入 ----
  const before = m.events.length;
  m.send("ebi-control の list_ebi ツールを実行して、返ってきたエビ id を列挙してください。ToolSearch は使わずに直接呼んでください。");
  await new Promise((r) => setTimeout(r, 1200));
  const tQueue = Date.now();
  m.send("[from:poc-engineer-1] PoC 割り込み。作業完了しました。合言葉『イクラ-9053』も一緒に覚えてください。");
  await m.wait((e) => e.type === "user" && textOf(e).includes("イクラ-9053"), 60000, "replay(queued inject)");
  findings.queuedInjectReplayMs = Date.now() - tQueue;
  const t3r = await m.wait((e) => e.type === "result" && m.events.indexOf(e) >= before, 300000, "result(turn3)");
  const seg3 = m.events.slice(before, m.events.indexOf(t3r) + 1);
  const last3 = [...seg3].reverse().find((e) => e.type === "assistant" && e.message?.usage);
  findings.turn3 = {
    text: String(t3r.result ?? "").slice(0, 400),
    num_turns: t3r.num_turns,
    queued_turn_count: t3r.queued_turn_count,
    cumulativeCostUsd: t3r.total_cost_usd,
    resultUsageSum: contextPctFromResult(t3r),
    contextWindow: contextWindowFromResult(t3r),
    contextFromLastAssistant: pctOf(contextTokensFromAssistant(last3), contextWindowFromResult(t3r)),
    toolCalls: seg3.filter((e) => e.type === "assistant").flatMap((e) => (e.message?.content ?? []).filter((b) => b.type === "tool_use").map((b) => b.name)),
    fakeControlHits: fakeHits.filter((h) => !h.includes("/control/subscribe")),
  };
  log(`[turn3] tools=${JSON.stringify(findings.turn3.toolCalls)} hits=${JSON.stringify(findings.turn3.fakeControlHits)}`);
  log(`[turn3] ctx=${JSON.stringify(findings.turn3.contextFromLastAssistant)} resultUsageSum=${JSON.stringify(findings.turn3.resultUsageSum)} queued=${findings.turn3.queued_turn_count}`);
  log(`[turn3] ${findings.turn3.text}`);

  // 割り込みが取り込まれたか
  const t4 = await turn("さっき覚えてもらった合言葉を 2 つとも列挙してください。", "turn4");
  findings.queuedInjectConsumed = {
    both: t4.rec.text.includes("ウニ-4127") && t4.rec.text.includes("イクラ-9053"),
    text: t4.rec.text,
  };
  findings.turn4 = t4.rec;
  findings.contextSeries = [
    findings.turn1.contextFromLastAssistant,
    findings.turn2.contextFromLastAssistant,
    findings.turn3.contextFromLastAssistant,
    findings.turn4.contextFromLastAssistant,
  ];
  findings.resultUsageSeries = [
    findings.turn1.resultUsageSum,
    findings.turn2.resultUsageSum,
    findings.turn3.resultUsageSum,
    findings.turn4.resultUsageSum,
  ];
  log(`ctx series (last-assistant): ${JSON.stringify(findings.contextSeries.map((c) => c && c.pct))}`);
  log(`ctx series (result.usage)  : ${JSON.stringify(findings.resultUsageSeries.map((c) => c && c.pct))}`);

  // ---- 6) 走行中の interrupt（control_request）----
  const beforeInt = m.events.length;
  m.send("1 から 300 まで、1 行に 1 つずつ数字だけを出力してください。途中で止めないでください。");
  await new Promise((r) => setTimeout(r, 4000));
  const reqId = `poc-int-${Date.now()}`;
  m.proc.stdin.write(JSON.stringify({ type: "control_request", request_id: reqId, request: { subtype: "interrupt" } }) + "\n");
  const tInt = Date.now();
  try {
    const resp = await m.wait((e) => e.type === "control_response" && m.events.indexOf(e) >= beforeInt, 60000, "control_response(interrupt)");
    const rInt = await m.wait((e) => e.type === "result" && m.events.indexOf(e) >= beforeInt, 120000, "result(after interrupt)");
    findings.interrupt = {
      ok: true,
      responseSubtype: resp.response?.subtype ?? resp.subtype,
      latencyMs: Date.now() - tInt,
      resultSubtype: rInt.subtype,
      processAlive: m.proc.exitCode === null,
    };
  } catch (e) {
    findings.interrupt = { ok: false, error: String(e), processAlive: m.proc.exitCode === null };
  }
  log(`interrupt: ${JSON.stringify(findings.interrupt)}`);

  // 中断後も会話が続くか
  try {
    const t5 = await turn("中断後の確認です。合言葉『ウニ-4127』を繰り返してください。", "turn5", 120000);
    findings.afterInterrupt = { alive: true, remembered: t5.rec.text.includes("ウニ-4127"), text: t5.rec.text };
  } catch (e) {
    findings.afterInterrupt = { alive: false, error: String(e) };
  }
  log(`afterInterrupt: ${JSON.stringify(findings.afterInterrupt)}`);

  // ---- 7) プロセス強制終了 → --resume 復帰 ----
  log(`SIGKILL run1 pid=${m.proc.pid}`);
  m.proc.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 3000));

  const m2 = spawnMaster(["--model", "opus", "--resume", sessionId], "run2");
  m2.send("復帰確認。覚えている合言葉を 2 つとも列挙してください。");
  const init2 = await m2.wait((e) => e.type === "system" && e.subtype === "init", 120000, "system.init(resume)");
  const r5 = await m2.wait((e) => e.type === "result", 180000, "result(resume)");
  const seg5 = m2.events.slice(0, m2.events.indexOf(r5) + 1);
  const last5 = [...seg5].reverse().find((e) => e.type === "assistant" && e.message?.usage);
  const t5text = String(r5.result ?? "");
  findings.resume = {
    session_id_after_resume: init2.session_id,
    same_session: init2.session_id === sessionId,
    both: t5text.includes("ウニ-4127") && t5text.includes("イクラ-9053"),
    text: t5text.slice(0, 300),
    contextWindow: contextWindowFromResult(r5),
    contextFromLastAssistant: pctOf(contextTokensFromAssistant(last5), contextWindowFromResult(r5)),
    cumulativeCostUsd: r5.total_cost_usd,
    mcp_servers: init2.mcp_servers,
  };
  log(`resume: same_session=${findings.resume.same_session} both=${findings.resume.both} ctx=${JSON.stringify(findings.resume.contextFromLastAssistant)} cost=${r5.total_cost_usd}`);
  m2.proc.kill("SIGKILL");

  writeFileSync(join(OUT, "findings.json"), JSON.stringify(findings, null, 2) + "\n");
  log(`findings -> ${join(OUT, "findings.json")}`);
}

main()
  .catch((e) => { log(`FAILED: ${e.stack ?? e}`); writeFileSync(join(OUT, "findings.json"), JSON.stringify({ ...findings, error: String(e) }, null, 2) + "\n"); process.exitCode = 1; })
  .finally(() => { log(`kill fake-control pid=${fake.pid}`); fake.kill("SIGTERM"); setTimeout(() => process.exit(process.exitCode ?? 0), 1000); });
