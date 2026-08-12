// master 起動不能インシデント（2026-08-12）の回帰ガード。
//
// 事象: master だけが ebi-team.config.json に `--mcp-config .../master-control.dev.mcp.json` を
// 手書きしており、`npm start`（本番）では `.dev` 無しのファイルしか生成されないためパスが不在。
// claude が起動直後にエラー終了し、1s→2s→4s→8s のバックオフ 5 回、起動から約 15 秒で
// crashloop 停止していた。しかも (a) PTY は即死してタイルごと消え (b) notice は broadcast のみで
// 揮発 (c) 恒久ログにも残らない、の三重で「エラーが何も出ない」ように見えた。
//
// 本テストが固定するのは 3 点:
//   1. MCP config パス解決が dev / 本番でファイル名を出し分ける（生成側スクリプトと同じ規約）
//   2. master 固定エビへの --mcp-config 自動付与（＋手動指定の尊重・重複ガード）
//   3. 可観測性: 固定エビの spawn 失敗 / crashloop 停止が恒久ログに残り、notice が
//      リングバッファに保持されて後から replay できる
//
// 実行: node --import tsx --test test/masterStartup.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";

import { isRunningFromSrc, mcpConfigPathFor } from "../src/server/mcpConfigPath.ts";
import { applyMasterMcpConfig, FixedEbiManager } from "../src/server/fixedEbi.ts";
import { NoticeBuffer } from "../src/server/noticeBuffer.ts";
import { configureFixedEbiLog, logFixedEbi, flushFixedEbiLog } from "../src/server/fixedEbiLog.ts";
import type { FixedEbiSpec } from "../src/server/config.ts";
import type { AgentHandlers } from "../src/server/agent.ts";

// ===== 1. MCP config パスの解決（dev / 本番の出し分け） =====

test("mcpConfigPathFor: dev は .dev 付き・本番は .dev 無しのファイル名を返す", () => {
  const base = "/repo";
  assert.equal(
    mcpConfigPathFor("master", { fromSrc: true, baseDir: base }),
    join(base, ".ebi-team", "master-control.dev.mcp.json"),
    "npm run dev（tsx / src 起点）は gen-master-mcp.mjs --dev の生成物を指すこと",
  );
  assert.equal(
    mcpConfigPathFor("master", { fromSrc: false, baseDir: base }),
    join(base, ".ebi-team", "master-control.mcp.json"),
    "npm start（node / dist 起点）は gen-master-mcp.mjs の生成物を指すこと（今回の障害の核心）",
  );
  // engineer 側も同じ規約であること（master だけ例外にしない）。
  assert.equal(
    mcpConfigPathFor("engineer", { fromSrc: true, baseDir: base }),
    join(base, ".ebi-team", "engineer-control.dev.mcp.json"),
  );
});

test("isRunningFromSrc: src/server 配下から動いていれば dev 判定になる", () => {
  assert.equal(isRunningFromSrc(join("/repo", "src", "server")), true);
  assert.equal(isRunningFromSrc(join("/repo", "dist", "server", "server")), false);
});

test("gen-master-mcp.mjs の生成ファイル名と解決規約が一致している", () => {
  // 生成側（スクリプト）と参照側（サーバ）でファイル名がずれると今回の障害が再発する。
  const script = readFileSync(new URL("../scripts/gen-master-mcp.mjs", import.meta.url), "utf8");
  for (const fromSrc of [true, false]) {
    for (const role of ["master", "engineer"] as const) {
      const name = mcpConfigPathFor(role, { fromSrc, baseDir: "/x" }).split("/").pop()!;
      assert.ok(
        script.includes(`"${name}"`),
        `gen-master-mcp.mjs が ${name} を生成すること（サーバ側の解決名と一致）`,
      );
    }
  }
});

// ===== 2. master への --mcp-config 自動付与 =====

/** テスト用の最小 FixedEbiSpec を作る。 */
function spec(overrides: Partial<FixedEbiSpec> & { args?: string[]; command?: string }): FixedEbiSpec {
  const { args, command, ...rest } = overrides;
  return {
    id: "master",
    kind: "master",
    notifySubscribe: true,
    launch: {
      command: command ?? "claude",
      args: args ?? ["--effort", "medium"],
      cwd: "/tmp",
      model: "fable",
    },
    ...rest,
  } as FixedEbiSpec;
}

const MCP = "/repo/.ebi-team/master-control.mcp.json";

test("master には --strict-mcp-config --mcp-config が自動付与される（config への手書き不要）", () => {
  const out = applyMasterMcpConfig(spec({}), MCP);
  assert.deepEqual(out.launch.args, ["--effort", "medium", "--strict-mcp-config", "--mcp-config", MCP]);
  // 元の spec は破壊しない（純関数）。
  assert.deepEqual(spec({}).launch.args, ["--effort", "medium"]);
});

test("args に --mcp-config が既にあれば自動付与しない（手動上書きの尊重）", () => {
  const manual = ["--mcp-config", "/custom/path.json"];
  const out = applyMasterMcpConfig(spec({ args: manual }), MCP);
  assert.deepEqual(out.launch.args, manual, "重複ガード: 二重の --mcp-config を作らない");
});

test("--strict-mcp-config が既にあれば重複させない", () => {
  const out = applyMasterMcpConfig(spec({ args: ["--strict-mcp-config"] }), MCP);
  assert.deepEqual(out.launch.args, ["--strict-mcp-config", "--mcp-config", MCP]);
});

test("master 以外の kind / claude 以外の command には付与しない", () => {
  const sup = spec({ id: "supervisor", kind: "supervisor" });
  assert.deepEqual(applyMasterMcpConfig(sup, MCP).launch.args, ["--effort", "medium"]);
  const bash = spec({ command: "bash", args: ["-c", "sleep 1"] });
  assert.deepEqual(applyMasterMcpConfig(bash, MCP).launch.args, ["-c", "sleep 1"]);
});

test("絶対パスの claude（/usr/local/bin/claude）でも付与される", () => {
  const out = applyMasterMcpConfig(spec({ command: "/usr/local/bin/claude" }), MCP);
  assert.ok(out.launch.args.includes("--mcp-config"));
});

// ===== 3. 可観測性: 固定エビの恒久ログ =====

test("固定エビの spawn 失敗と crashloop 停止が恒久ログ（JSONL）に残る", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ebi-fixedebi-log-"));
  const logPath = join(dir, "fixed-ebi.log");
  try {
    configureFixedEbiLog(logPath);

    // spawn が必ず失敗する Registry スタブ。FixedEbiManager は再起動フローに乗せる。
    const registry = {
      has: () => false,
      spawn: () => {
        throw new Error("MCP config file not found");
      },
    };
    const notices: string[] = [];
    const handlers = { onNotice: (_id: string, text: string) => notices.push(text) } as unknown as AgentHandlers;

    // バックオフ 0ms・2 連続失敗で crashloop 停止（テストを即決させる）。
    const mgr = new FixedEbiManager(registry as never, {
      baseDelayMs: 0,
      maxDelayMs: 0,
      maxConsecutiveFailures: 2,
      minHealthyMs: 10_000,
    });
    mgr.start([applyMasterMcpConfig(spec({}), MCP)], handlers);
    // 0ms バックオフの再起動を 1 周させる。
    await new Promise((r) => setTimeout(r, 30));
    mgr.stop();

    await flushFixedEbiLog();
    assert.ok(existsSync(logPath), "固定エビログのファイルが作られること");
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const events = lines.map((l) => l.event);
    assert.ok(events.includes("spawn-failed"), `spawn 失敗が記録されること: ${events.join(",")}`);
    assert.ok(
      events.includes("crashloop-stopped"),
      `crashloop 停止が記録されること: ${events.join(",")}`,
    );
    // 起動引数（＝原因の本体）がログに載っていること。事後追跡でこれが無いと詰む。
    const failed = lines.find((l) => l.event === "spawn-failed");
    assert.ok(failed.args.includes("--mcp-config"), "解決済みの起動引数が残ること");
    assert.equal(failed.id, "master");
    assert.ok(notices.some((t) => t.includes("crashloop")), "notice でも知らせること");
  } finally {
    // 以降のテストがファイルを作らないよう出力先を戻す。
    configureFixedEbiLog(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===== 3b. 可観測性: notice リングバッファ（新規接続への replay） =====

test("NoticeBuffer: 直近 N 件を古い順に保持し、上限を超えたら古いものから捨てる", () => {
  const buf = new NoticeBuffer(3);
  buf.push("master", "1", 100);
  buf.push("master", "2", 200);
  buf.push("master", "3", 300);
  buf.push("master", "4", 400);
  assert.deepEqual(
    buf.list().map((n) => n.text),
    ["2", "3", "4"],
    "古い順（replay の送出順）で返すこと",
  );
  assert.equal(buf.size, 3);
  assert.equal(buf.list()[0].ts, 200, "発生時刻を保持すること（replay 時の表示に使う）");
});

test("NoticeBuffer: 容量 0 なら何も保持しない（EBI_NOTICE_BUFFER_SIZE=0 で無効化）", () => {
  const buf = new NoticeBuffer(0);
  buf.push("master", "x");
  assert.equal(buf.size, 0);
});

test("NoticeBuffer: list() のスナップショットを書き換えても内部状態は壊れない", () => {
  const buf = new NoticeBuffer(2);
  buf.push("a", "1");
  buf.list().pop();
  assert.equal(buf.size, 1);
});
