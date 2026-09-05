// PR-M2 のサーバ配線まわり（config の ui/brain・EBI_MASTER_UI 上書き・会話 JSONL・
// rate_limit_event の正規化・registry の chat 配送先）のテスト。
//
// 実行: node --import tsx --test test/masterChatWiring.test.ts

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixedEbi } from "../src/server/config.ts";
import { applyMasterUiOverride } from "../src/server/fixedEbi.ts";
import { ChatLog, parseChatLogLine, parseChatLogTail } from "../src/server/master/chatLog.ts";
import { parseRateLimitEvent, utilizationToPct } from "../src/server/master/rateLimit.ts";
import { Registry } from "../src/server/registry.ts";
import { UsageStore } from "../src/server/usageStore.ts";
import type { AgentRecord, MasterChatEnvelope } from "../src/shared/protocol.ts";
import type { SpawnConfig } from "../src/server/agent.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ebi-m2-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeConfig(dir: string, fixedEbi: unknown[]): string {
  const p = join(dir, "ebi-team.config.json");
  writeFileSync(p, JSON.stringify({ fixedEbi }, null, 2));
  return p;
}

// ===== config: ui / brain =====

test("ui 未指定なら terminal・brain 未指定なら claude（既定は現行の PTY 経路）", async () => {
  const dir = tmp();
  const p = writeConfig(dir, [{ id: "master", kind: "master", cwd: dir, model: "opus" }]);
  const specs = await loadFixedEbi(p, { command: "claude" });
  assert.equal(specs[0]!.ui, "terminal");
  assert.equal(specs[0]!.brain, "claude");
  assert.equal(specs[0]!.permissionMode, "auto");
});

test('ui:"chat" / brain:"codex" を読み取る（codex は opt-in）', async () => {
  const dir = tmp();
  const p = writeConfig(dir, [
    { id: "master", kind: "master", cwd: dir, ui: "chat", brain: "codex", args: ["--effort", "medium"] },
  ]);
  const specs = await loadFixedEbi(p, { command: "claude" });
  assert.equal(specs[0]!.ui, "chat");
  assert.equal(specs[0]!.brain, "codex");
  // extraArgs は方言フラグを付ける前の生の追加引数（chat は launch.args を通さない）。
  assert.deepEqual(specs[0]!.extraArgs, ["--effort", "medium"]);
});

test("ui の値域外・master 以外への ui:chat・未知の brain は明示エラー", async () => {
  const dir = tmp();
  await assert.rejects(
    () => loadFixedEbi(writeConfig(dir, [{ id: "m", kind: "master", cwd: dir, ui: "gui" }]), { command: "claude" }),
    /ui が不正/,
  );
  await assert.rejects(
    () =>
      loadFixedEbi(writeConfig(dir, [{ id: "s", kind: "supervisor", cwd: dir, ui: "chat" }]), {
        command: "claude",
      }),
    /kind:"master" のみ/,
  );
  await assert.rejects(
    () => loadFixedEbi(writeConfig(dir, [{ id: "m", kind: "master", cwd: dir, brain: "grok" }]), { command: "claude" }),
    /brain が不正/,
  );
});

// ===== EBI_MASTER_UI 上書き =====

const masterSpec = {
  id: "master",
  kind: "master" as const,
  ui: "chat" as const,
  brain: "claude" as const,
  permissionMode: "auto" as const,
  extraArgs: [],
  launch: { command: "claude", args: [], cwd: "/tmp", model: null },
  notifySubscribe: false,
};

test("EBI_MASTER_UI=terminal で chat から切り戻せる（再起動 1 手のロールバック）", () => {
  assert.equal(applyMasterUiOverride(masterSpec, "terminal").ui, "terminal");
  assert.equal(applyMasterUiOverride({ ...masterSpec, ui: "terminal" }, "chat").ui, "chat");
});

test("EBI_MASTER_UI が未設定・不正値なら何もしない（起動を止めない）", () => {
  assert.equal(applyMasterUiOverride(masterSpec, undefined).ui, "chat");
  assert.equal(applyMasterUiOverride(masterSpec, "").ui, "chat");
  assert.equal(applyMasterUiOverride(masterSpec, "gui").ui, "chat");
  // master 以外は素通し。
  const sup = { ...masterSpec, id: "supervisor", kind: "supervisor" as const, ui: "terminal" as const };
  assert.equal(applyMasterUiOverride(sup, "chat").ui, "terminal");
});

// ===== 会話 JSONL =====

const env = (seq: number): MasterChatEnvelope => ({
  seq,
  ts: 1_700_000_000_000 + seq,
  event: { kind: "user", text: `m${seq}` },
});

test("会話ログは JSONL で往復でき、末尾 N 件を seq 昇順で復元する", async () => {
  const dir = tmp();
  const log = new ChatLog();
  log.configure(join(dir, "chat.jsonl"));
  for (let i = 1; i <= 5; i++) log.append(env(i));
  await log.flush();
  const tail = await log.tail(3);
  assert.deepEqual(tail.map((e) => e.seq), [3, 4, 5]);
  assert.deepEqual(tail[0]!.event, { kind: "user", text: "m3" });
});

test("configure されるまでファイルへ書かない（テストが勝手にファイルを作らない）", async () => {
  const log = new ChatLog();
  log.append(env(1));
  await log.flush();
  assert.deepEqual(await log.tail(10), []);
});

test("壊れた行・形が違う行は読み捨てる（復元の失敗で起動を止めない）", () => {
  assert.equal(parseChatLogLine("{壊れ"), null);
  assert.equal(parseChatLogLine('{"seq":1}'), null);
  assert.equal(parseChatLogLine('{"seq":"a","ts":1,"event":{"kind":"user"}}'), null);
  const text = ['{"bad"', JSON.stringify(env(2)), "", JSON.stringify(env(1))].join("\n");
  assert.deepEqual(parseChatLogTail(text, 10).map((e) => e.seq), [1, 2]);
});

// ===== rate_limit_event =====

test("utilization は 0〜1 の割合として % に直す（PoC 0.13 ≒ 13%）", () => {
  assert.ok(Math.abs((utilizationToPct(0.13) ?? 0) - 13) < 1e-9);
  assert.equal(utilizationToPct(0), 0);
  // 1 を超える値は既に % とみなす（CLI 側の表記変更に対する保険）。
  assert.equal(utilizationToPct(42), 42);
  assert.equal(utilizationToPct(null), null);
  assert.equal(utilizationToPct("0.5"), null);
});

test("rate_limit_event から 5h / 週次の枠を取り出す（PoC の実物と同じ形）", () => {
  const raw = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: 1788588600,
      rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 0.13, resetsAt: 1788588600 },
        seven_day: { utilization: 0.03, resetsAt: 1789030800 },
      },
    },
  };
  const parsed = parseRateLimitEvent(raw);
  assert.ok(parsed);
  assert.ok(Math.abs(parsed!.fiveHour!.usedPct - 13) < 1e-9);
  assert.equal(parsed!.fiveHour!.resetsAt, 1788588600);
  assert.ok(Math.abs(parsed!.sevenDay!.usedPct - 3) < 1e-9);
  // 対象外の type・形が違うものは null（更新しない）。
  assert.equal(parseRateLimitEvent({ type: "result" }), null);
  assert.equal(parseRateLimitEvent({ type: "rate_limit_event" }), null);
});

test("UsageStore は chat 由来の usage / 枠を statusLine 由来と同じ形で保持する", () => {
  const history: unknown[] = [];
  const store = new UsageStore((rec) => history.push(rec));
  store.updateFromChat("master", {
    model: "Opus 5",
    costUsd: 1.5,
    contextUsedPct: 31.2,
    contextSize: 1_000_000,
    tokens: { input: 100, output: 20, cacheRead: 900, cacheCreation: 0 },
  });
  store.updateRateLimits("master", { fiveHour: { usedPct: 13, resetsAt: 1788588600 } });
  const snap = store.snapshot();
  assert.equal(snap.agents[0]!.id, "master");
  assert.equal(snap.agents[0]!.contextUsedPct, 31.2);
  assert.equal(snap.totalCostUsd, 1.5);
  assert.deepEqual(snap.rateLimits.fiveHour, { usedPct: 13, resetsAt: 1788588600 });
  assert.equal(history.length, 1, "枠の変化は履歴に 1 行残る");
  // 同じ値の再受信では履歴を増やさない。
  store.updateRateLimits("master", { fiveHour: { usedPct: 13, resetsAt: 1788588600 } });
  assert.equal(history.length, 1);
});

// ===== registry の chat 配送先 =====

const spawnConfig: SpawnConfig = {
  command: "bash",
  args: ["-c", "cat"],
  idleThresholdMs: 150,
  scrollbackBytes: 1024,
  devChannelsAllowlist: [],
};

function chatRegistry() {
  // dump 先は afterEach で消える tmpdir を避ける（非同期 dump が ENOENT で騒ぐため）。
  const reg = new Registry(spawnConfig, join(tmpdir(), "ebi-m2-registry.json"), null);
  const calls: { from: string; body: string; kind: string }[] = [];
  const record: AgentRecord = {
    id: "master",
    cwd: "/tmp",
    branch: null,
    status: "idle",
    mode: "connected",
    pid: 1234,
    kind: "master",
    pinned: true,
    model: "opus",
    role: null,
    backend: "claude",
  };
  reg.setChatTarget("master", {
    record: () => record,
    deliver: (input) => {
      calls.push({ from: input.from, body: input.body, kind: input.kind });
      return Promise.resolve({ ok: true, confirmed: true });
    },
  });
  return { reg, calls };
}

test("chat master は PTY 無しで宛先解決でき、reverseInject が via:chat で届く", async () => {
  const { reg, calls } = chatRegistry();
  assert.equal(reg.has("master"), true);
  assert.equal(reg.isPinned("master"), true, "chat master も削除不可");
  assert.equal(reg.list().map((a) => a.id).join(","), "master");

  const r = await reg.reverseInject("ebi-1", "master", "完了しました", "reply");
  assert.deepEqual(r.delivered, ["master"]);
  assert.deepEqual(r.details[0], { id: "master", via: "chat", confirmed: true, queued: false });
  // PTY 注入と同じタグ表記のまま stdin へ載る。
  assert.deepEqual(calls[0], { from: "ebi-1", body: "[reply] 完了しました", kind: "reply" });
});

test("chat master への順方向 inject（inject_message）も同じ口へ載る", async () => {
  const { reg, calls } = chatRegistry();
  const r = await reg.resolveAndInject("master", "user", "指示です");
  assert.deepEqual(r.delivered, ["master"]);
  assert.equal(r.details[0]!.via, "chat");
  assert.deepEqual(calls[0], { from: "user", body: "指示です", kind: "message" });
});

test("chat 配送先を解除すると宛先として見えなくなる", async () => {
  const { reg } = chatRegistry();
  reg.clearChatTarget("master");
  assert.equal(reg.has("master"), false);
  const r = await reg.reverseInject("ebi-1", "master", "報告", "reply");
  assert.deepEqual(r.delivered, []);
  assert.match(r.rejected[0]!.reason, /宛先が見つかりません/);
});

test("chat master と同名の PTY エビは spawn できない（同名二重エビの防止）", () => {
  const { reg } = chatRegistry();
  assert.throws(
    () => reg.spawn(".", { onData() {}, onStatus() {}, onExit() {}, onNotice() {} }, { id: "master" }),
    /chat モードの master/,
  );
});
