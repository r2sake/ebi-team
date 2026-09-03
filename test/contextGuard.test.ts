// context-guard（master コンテキスト枯渇ガード）のユニットテスト。
//
// 錠前化する不変条件:
//   - 閾値（soft=65 / hard=70 / critical=85）と「同レベル内では鳴らない」抑止
//   - 65% 到達の瞬間は **キリの良し悪しに関係なく** 予告（advance）が 1 回出る（ボス追加要件）
//   - キリが付いた時点で /clear 促し（quiescent）が 1 回だけ出る（X-5）
//   - 整数刻みのチャタリング吸収（rearm マージン）と、下降時のリセット→再武装
//   - null / stale はスキップしてレベル据え置き
//   - EBI_CTX_GUARD=off で一切発火しない
//   - inject 文面（転記用定型文）に数値・上限・走行中エビ数が入る
//
// 実行: node --import tsx --test test/contextGuard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ContextGuard,
  isQuiescent,
  contextGuardConfigFromEnv,
  DEFAULT_CONTEXT_GUARD_CONFIG,
  type GuardNotice,
  type ContextGuardConfig,
} from "../src/server/contextGuard.ts";
import type { UsageAgent, AgentRecord } from "../src/shared/protocol.ts";

const NOW = 1_800_000_000_000;

function usage(pct: number | null, overrides: Partial<UsageAgent> = {}): UsageAgent {
  return {
    id: "master",
    model: "Fable 5.1",
    costUsd: 1,
    contextUsedPct: pct,
    contextSize: 1_000_000,
    tokens: { input: null, output: null, cacheRead: null, cacheCreation: null },
    updatedAt: NOW,
    ...overrides,
  };
}

function agent(id: string, status: "idle" | "busy", kind: AgentRecord["kind"]): AgentRecord {
  return {
    id,
    cwd: "/tmp",
    branch: null,
    status,
    mode: "pty",
    pid: 1,
    kind,
    pinned: kind !== "dynamic",
    model: null,
  } as AgentRecord;
}

/** キリが良い状態（master idle・dynamic 無し）。 */
const QUIET: AgentRecord[] = [agent("master", "idle", "master")];
/** キリが悪い状態（dynamic が 1 匹 busy）。 */
const BUSY: AgentRecord[] = [agent("master", "idle", "master"), agent("ebi-1", "busy", "dynamic")];

function makeGuard(cfg: Partial<ContextGuardConfig> = {}) {
  const notices: GuardNotice[] = [];
  const guard = new ContextGuard(cfg, (n) => notices.push(n));
  return { guard, notices };
}

const kinds = (ns: GuardNotice[]) => ns.map((n) => n.kind);

test("64% では何も鳴らず level は none", () => {
  const { guard, notices } = makeGuard();
  guard.observe(usage(64), QUIET, NOW);
  assert.equal(guard.level(), "none");
  assert.deepEqual(kinds(notices), []);
});

test("65% はキリが悪くても予告(advance)を 1 回出す（ボス追加要件）", () => {
  const { guard, notices } = makeGuard();
  guard.observe(usage(65), BUSY, NOW);
  assert.equal(guard.level(), "soft");
  assert.deepEqual(kinds(notices), ["advance"]);
  assert.equal(notices[0]!.quiescent, false);
  assert.equal(notices[0]!.busyDynamic, 1);
});

test("キリが悪い間は /clear 促しを保留し、キリが付いた最初の observe で 1 回だけ出す（X-5）", () => {
  const { guard, notices } = makeGuard();
  guard.observe(usage(65), BUSY, NOW);
  guard.observe(usage(66), BUSY, NOW + 1000);
  assert.deepEqual(kinds(notices), ["advance"]);

  guard.observe(usage(66), QUIET, NOW + 2000);
  assert.deepEqual(kinds(notices), ["advance", "quiescent"]);

  // 以後キリが良いままでも再発火しない。
  guard.observe(usage(67), QUIET, NOW + 3000);
  assert.deepEqual(kinds(notices), ["advance", "quiescent"]);
});

test("65% 到達時に既にキリが良ければ advance と quiescent が同時に出る", () => {
  const { guard, notices } = makeGuard();
  guard.observe(usage(65), QUIET, NOW);
  assert.deepEqual(kinds(notices), ["advance", "quiescent"]);
});

test("65 → 66 → 68 で advance は 1 回だけ（同レベル抑止）", () => {
  const { guard, notices } = makeGuard();
  for (const [i, p] of [65, 66, 68].entries()) guard.observe(usage(p), BUSY, NOW + i * 1000);
  assert.deepEqual(kinds(notices), ["advance"]);
});

test("69 → 70 → 69 → 70 で hard は 1 回だけ（rearm マージンでチャタリングしない）", () => {
  const { guard, notices } = makeGuard();
  for (const [i, p] of [69, 70, 69, 70].entries()) guard.observe(usage(p), BUSY, NOW + i * 1000);
  assert.deepEqual(kinds(notices), ["advance", "hard"]);
  assert.equal(guard.level(), "hard");
});

test("70 → 60（下降）→ 70 で none に戻り、advance / hard が再発火する", () => {
  const { guard, notices } = makeGuard();
  guard.observe(usage(70), BUSY, NOW);
  assert.deepEqual(kinds(notices), ["advance", "hard"]);

  guard.observe(usage(60), BUSY, NOW + 1000);
  assert.equal(guard.level(), "none");

  guard.observe(usage(70), BUSY, NOW + 2000);
  assert.deepEqual(kinds(notices), ["advance", "hard", "advance", "hard"]);
});

test("85% は cooldown 経過ごとに再通知する（それ以外は鳴らない）", () => {
  const { guard, notices } = makeGuard({ cooldownMs: 10_000 });
  guard.observe(usage(85), BUSY, NOW);
  assert.deepEqual(kinds(notices), ["advance", "critical"]);

  guard.observe(usage(86), BUSY, NOW + 5_000); // cooldown 未経過
  assert.deepEqual(kinds(notices), ["advance", "critical"]);

  guard.observe(usage(86), BUSY, NOW + 10_001); // cooldown 経過
  assert.deepEqual(kinds(notices), ["advance", "critical", "critical"]);
});

test("contextUsedPct が null なら判定をスキップしてレベルを据え置く", () => {
  const { guard, notices } = makeGuard();
  guard.observe(usage(70), BUSY, NOW);
  notices.length = 0;
  guard.observe(usage(null), BUSY, NOW + 1000);
  assert.equal(guard.level(), "hard");
  assert.deepEqual(kinds(notices), []);
});

test("null が閾値回数だけ連続したら健全性 notice を 1 回だけ出す", () => {
  const { guard, notices } = makeGuard({ nullHealthThreshold: 3 });
  for (let i = 0; i < 5; i++) guard.observe(usage(null), QUIET, NOW + i);
  assert.deepEqual(kinds(notices), ["health"]);
});

test("updatedAt が staleMs を超えていたら判定をスキップする", () => {
  const { guard, notices } = makeGuard({ staleMs: 1000 });
  guard.observe(usage(90, { updatedAt: NOW - 5000 }), QUIET, NOW);
  assert.equal(guard.level(), "none");
  assert.deepEqual(kinds(notices), []);
});

test("監視対象以外の usage は無視する", () => {
  const { guard, notices } = makeGuard();
  guard.observe(usage(90, { id: "ebi-1" }), QUIET, NOW);
  assert.equal(guard.level(), "none");
  assert.deepEqual(kinds(notices), []);
});

test("enabled=false なら一切発火しない", () => {
  const { guard, notices } = makeGuard({ enabled: false });
  guard.observe(usage(95), QUIET, NOW);
  assert.equal(guard.level(), "none");
  assert.deepEqual(kinds(notices), []);
});

test("quiescent 判定: master busy / dynamic に busy が 1 匹 → いずれも false", () => {
  assert.equal(isQuiescent(QUIET), true);
  assert.equal(isQuiescent(BUSY), false);
  assert.equal(isQuiescent([agent("master", "busy", "master")]), false);
  // supervisor（非 dynamic）が busy でもキリの良さには影響しない。
  assert.equal(
    isQuiescent([agent("master", "idle", "master"), agent("supervisor", "busy", "supervisor")]),
    true,
  );
  // master 不在なら判定不能＝false。
  assert.equal(isQuiescent([agent("ebi-1", "idle", "dynamic")]), false);
});

test("advance の文面に転記用の定型文と 数値/上限/走行中エビ数 が入る", () => {
  const { guard, notices } = makeGuard();
  guard.observe(usage(65), BUSY, NOW);
  const text = notices[0]!.text;
  assert.match(text, /--- ここから ---/);
  assert.match(text, /--- ここまで ---/);
  assert.match(text, /コンテキストが 65%（上限 1,000,000 tokens）に達しました/);
  assert.match(text, /走行中のエビは 1 匹です/);
  assert.match(text, /キリが良くなるよう（走行中タスクの区切り・報告集約）進めてください/);
  assert.match(text, /キリが付いたら \/clear を促します/);
});

test("hard / critical / quiescent の文面にハンドオフ手順が入る", () => {
  const { guard, notices } = makeGuard();
  guard.observe(usage(70), QUIET, NOW);
  guard.observe(usage(85), QUIET, NOW + 1000);
  for (const n of notices.filter((x) => x.kind !== "advance")) {
    assert.match(n.text, /ハンドオフ手順|ops\/daily-handoff/);
  }
});

test("contextSize が null でも文面が壊れない（上限不明）", () => {
  const { guard, notices } = makeGuard();
  guard.observe(usage(70, { contextSize: null }), BUSY, NOW);
  assert.match(notices[0]!.text, /上限不明/);
});

test("env から設定を読む（既定 on・上書き可）", () => {
  assert.deepEqual(contextGuardConfigFromEnv({}), DEFAULT_CONTEXT_GUARD_CONFIG);
  const cfg = contextGuardConfigFromEnv({
    EBI_CTX_GUARD: "off",
    EBI_CTX_GUARD_SOFT_PCT: "50",
    EBI_CTX_GUARD_TARGET: "ebi-1",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.softPct, 50);
  assert.equal(cfg.targetId, "ebi-1");
  // 不正値は既定にフォールバックする。
  assert.equal(
    contextGuardConfigFromEnv({ EBI_CTX_GUARD_HARD_PCT: "abc" } as NodeJS.ProcessEnv).hardPct,
    70,
  );
});
