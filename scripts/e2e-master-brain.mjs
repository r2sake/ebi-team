// PR-M1 opt-in 結合確認: ClaudeHeadlessBrain で実プロセスを 1 本立てて 2 ターン往復する。
//
// **既定では走らせない**（`npm run test:unit` にも入れない）。サブスク枠を実際に消費するため、
// 人が明示的に叩いたときだけ動かす:
//
//   node --import tsx scripts/e2e-master-brain.mjs
//
// 安全条件（PR-M0 PoC 踏襲）:
//  - 稼働 control API（127.0.0.1:8787）には触らない。偽 control API を別ポート（既定 9913）に立てる。
//  - `.ebi-team/` の既存 mcp config は上書きしない（一時ディレクトリに PoC 専用 config を作る）。
//  - 停止は必ず PID 指定（brain.stop() / child.kill()）。広域 pkill はしない。
//
// 確認項目:
//  1 起動が init を待たずに resolve する（デッドロックしない）
//  2 send() が replay ACK で acked:true を返す
//  3 assistant テキストと turnEnd（usage / contextUsedPct / costUsd）が取れる
//  4 2 ターン目で記憶が繋がる
//  5 中断（control_request interrupt）が turnEnd{aborted:true} として出る
//  6 apiKeySource === "none"（サブスク OAuth で走っている）

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClaudeHeadlessBrain } from "../src/server/master/claudeBrain.ts";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = mkdtempSync(join(tmpdir(), "ebi-m1-"));
const PORT = Number(process.env.EBI_M1_CONTROL_PORT ?? 9913);
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

const fakeSrc = `
import { createServer } from "node:http";
createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    console.log("HIT " + req.method + " " + url.pathname);
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/control/agents") {
      res.end(JSON.stringify({ agents: [{ id: "master", kind: "fixed", status: "busy" }] }));
    } else { res.statusCode = 404; res.end(JSON.stringify({ error: "not found" })); }
  });
}).listen(${PORT}, "127.0.0.1", () => console.log("listening ${PORT}"));
`;
writeFileSync(join(OUT, "fake-control.mjs"), fakeSrc);
const mcpConfigPath = join(OUT, "master.mcp.json");
writeFileSync(
  mcpConfigPath,
  `${JSON.stringify(
    {
      mcpServers: {
        "ebi-control": {
          command: join(ROOT, "node_modules/.bin/tsx"),
          args: [join(ROOT, "src/mcp/control-server.ts")],
          cwd: ROOT,
          env: { EBI_CONTROL_URL: `http://127.0.0.1:${PORT}`, EBI_MCP_ROLE: "master" },
        },
      },
    },
    null,
    2,
  )}\n`,
);

const fake = spawn(process.execPath, [join(OUT, "fake-control.mjs")], {
  stdio: ["ignore", "pipe", "pipe"],
});
fake.stdout.on("data", (d) => log(`fake-control> ${String(d).trim()}`));

const brain = new ClaudeHeadlessBrain();
const seen = { session: null, texts: [], turnEnds: [] };
let failed = 0;
const check = (ok, what) => {
  log(`${ok ? "OK  " : "NG  "} ${what}`);
  if (!ok) failed++;
};

(async () => {
  const t0 = Date.now();
  await brain.start({
    cwd: ROOT,
    model: "opus",
    permissionMode: "auto",
    systemPrompt: "あなたは ebi-team の master です。日本語で簡潔に答えてください。",
    controlMcp: null,
    mcpConfigPath,
    resumeSessionId: null,
    extraArgs: [],
  });
  check(Date.now() - t0 < 30_000, `start() が init を待たずに resolve（${Date.now() - t0}ms）`);

  const pump = (async () => {
    for await (const ev of brain.events()) {
      if (ev.kind === "session") seen.session = ev;
      else if (ev.kind === "text" && !ev.partial) seen.texts.push(ev.text);
      else if (ev.kind === "turnEnd") seen.turnEnds.push(ev);
      else if (ev.kind === "notice") log(`notice(${ev.level}): ${ev.text}`);
      else if (ev.kind === "exit") log(`exit code=${ev.code} sig=${ev.signal}`);
    }
  })();

  const waitTurns = async (n, ms = 180_000) => {
    const until = Date.now() + ms;
    while (seen.turnEnds.length < n && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return seen.turnEnds.length >= n;
  };

  const a1 = await brain.send({ text: "合言葉『ウニ-4127』を覚えて。覚えたとだけ返して。" });
  check(a1.acked, "ターン1 の replay ACK が返る");
  check(await waitTurns(1), "ターン1 の turnEnd が来る");
  check(seen.session?.apiKeySource === "none", `apiKeySource=none（実測 ${seen.session?.apiKeySource}）`);
  check(
    seen.session?.mcpServers?.some((s) => s.name === "ebi-control" && s.status === "connected"),
    "ebi-control が connected",
  );
  const u1 = seen.turnEnds[0]?.usage;
  check(u1?.contextUsedPct != null, `文脈使用率が算出できる（${u1?.contextUsedPct}% / ${u1?.contextSize}）`);
  check(seen.turnEnds[0]?.costUsd != null, `costUsd が載る（${seen.turnEnds[0]?.costUsd}）`);

  await brain.send({ text: "さっきの合言葉をそのまま繰り返して。" });
  check(await waitTurns(2), "ターン2 の turnEnd が来る");
  check(seen.texts.join("").includes("ウニ-4127"), "2 ターン目に記憶が繋がっている");
  const u2 = seen.turnEnds[1]?.usage;
  check(
    (u2?.contextTokens ?? 0) >= (u1?.contextTokens ?? 0),
    `文脈トークンが単調（${u1?.contextTokens} → ${u2?.contextTokens}）`,
  );

  brain.send({ text: "1 から 300 まで 1 行に 1 つずつ数字だけ出力して。" }).catch(() => {});
  await new Promise((r) => setTimeout(r, 4000));
  await brain.interrupt();
  check(await waitTurns(3, 60_000), "中断後に turnEnd が来る");
  const last = seen.turnEnds[2];
  check(last?.aborted === true, "中断は aborted:true（通常エラーに化けない）");
  check(last?.errorText === null, "中断では errorText を出さない");

  await brain.stop();
  await pump;
  log(`累計コスト（プロセス跨ぎ）: $${brain.costLedger.total().toFixed(6)}`);
  fake.kill("SIGTERM");
  log(failed === 0 ? "ALL OK" : `FAILED: ${failed} 件`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (err) => {
  log(`ERROR: ${err?.stack ?? err}`);
  await brain.stop().catch(() => {});
  fake.kill("SIGTERM");
  process.exit(1);
});
