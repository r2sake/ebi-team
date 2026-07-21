// Mailbox（notification 注入方式の郵便受け）のユニットテスト。
//
// 2026-07-20 の配送信頼性根治で追加した中核を deterministic に検証する:
//   - push が seq id を採番して返す / subscribe が pending を消費する
//   - isLive: 直近 long-poll があれば live、時間窓を過ぎたら dead（配送ゲートの肝）
//   - ack / waitForAck: end-to-end ACK の解決・タイムアウト・順序前後（orphan ack）
//   - take: pending からの回収（PTY フォールバック時の二重配送防止）
//   - pendingSnapshot: 未回収の可視化
//   - clear: 破棄した pending を返す（黙って消えないことの担保）
//
// 実行: node --import tsx --test test/mailbox.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { Mailbox } from "../src/server/mailbox.ts";

const baseMsg = { from: "master", message: "hi", kind: "message" as const, ts: 1000 };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("push は seq id を採番して返し、subscribe が pending を消費する", async () => {
  const mb = new Mailbox();
  const id1 = mb.push("ebi-1", { ...baseMsg });
  const id2 = mb.push("ebi-1", { ...baseMsg, message: "second" });
  assert.equal(id1, 1);
  assert.equal(id2, 2);
  assert.equal(mb.pendingCount("ebi-1"), 2);

  const got = await mb.subscribe("ebi-1", 1000);
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((m) => m.id), [1, 2]);
  assert.equal(got[0]!.message, "hi");
  // 消費済みなので pending は空。
  assert.equal(mb.pendingCount("ebi-1"), 0);
});

test("待機中の long-poll があれば push は即時 resolve する", async () => {
  const mb = new Mailbox();
  const p = mb.subscribe("ebi-1", 1000);
  const seqId = mb.push("ebi-1", { ...baseMsg, message: "live" });
  const got = await p;
  assert.equal(got.length, 1);
  assert.equal(got[0]!.id, seqId);
  assert.equal(got[0]!.message, "live");
});

test("isLive: subscribe 直後は live・時間窓を過ぎると dead（配送ゲート）", async () => {
  // liveness window を極小（30ms）にして、購読が古びると dead 判定になることを確認。
  const mb = new Mailbox(30);
  assert.equal(mb.isLive("ebi-1"), false, "一度も購読していなければ dead");

  // timeout 即返しの subscribe で lastPollAt を打刻。
  await mb.subscribe("ebi-1", 1);
  assert.equal(mb.isLive("ebi-1"), true, "購読直後は live");

  await sleep(60);
  assert.equal(mb.isLive("ebi-1"), false, "window を過ぎたら dead（everSubscribed とは別物）");
});

test("everSubscribed は単調（過去の購読で true のまま）＝配送ゲートに使ってはいけない", async () => {
  const mb = new Mailbox(30);
  await mb.subscribe("ebi-1", 1);
  await sleep(60);
  // 購読は古びて dead になったが、everSubscribed は true のまま（旧バグの温床）。
  assert.equal(mb.everSubscribed("ebi-1"), true);
  assert.equal(mb.isLive("ebi-1"), false);
});

test("ack / waitForAck: ACK が来れば true で解決する", async () => {
  const mb = new Mailbox();
  const seqId = mb.push("ebi-1", { ...baseMsg });
  const p = mb.waitForAck("ebi-1", seqId, 1000);
  mb.ack("ebi-1", [seqId]);
  assert.equal(await p, true);
});

test("waitForAck: ACK が来なければ timeout で false（→ 呼び出し側が PTY フォールバック）", async () => {
  const mb = new Mailbox();
  const seqId = mb.push("ebi-1", { ...baseMsg });
  const acked = await mb.waitForAck("ebi-1", seqId, 50);
  assert.equal(acked, false);
});

test("orphan ack: waitForAck より先に ack が来ても取りこぼさない", async () => {
  const mb = new Mailbox();
  const seqId = mb.push("ebi-1", { ...baseMsg });
  // 先に ACK が到着（waiter 未登録）。
  mb.ack("ebi-1", [seqId]);
  // 後から待っても即 true。
  assert.equal(await mb.waitForAck("ebi-1", seqId, 50), true);
  // 一度消費したら二度目は待つ（同じ orphan を再利用しない）。
  assert.equal(await mb.waitForAck("ebi-1", seqId, 30), false);
});

test("ack の宛先/ seq id が違えば解決しない", async () => {
  const mb = new Mailbox();
  const seqId = mb.push("ebi-1", { ...baseMsg });
  const p = mb.waitForAck("ebi-1", seqId, 60);
  mb.ack("ebi-1", [seqId + 999]); // 別の id
  mb.ack("ebi-2", [seqId]); // 別の宛先
  assert.equal(await p, false);
});

test("take: pending から seq id を回収して二重配送を防ぐ", () => {
  const mb = new Mailbox();
  const a = mb.push("ebi-1", { ...baseMsg, message: "a" });
  const b = mb.push("ebi-1", { ...baseMsg, message: "b" });
  const taken = mb.take("ebi-1", a);
  assert.equal(taken?.message, "a");
  assert.equal(mb.pendingCount("ebi-1"), 1);
  // 既にブリッジが拾って pending に無いものは null（＝回収不要）。
  assert.equal(mb.take("ebi-1", a), null);
  assert.equal(mb.take("ebi-1", b)?.message, "b");
  assert.equal(mb.pendingCount("ebi-1"), 0);
});

test("pendingSnapshot: 未回収を可視化する（黙って消えていないことの観測入口）", () => {
  const mb = new Mailbox();
  const now = 10_000;
  mb.push("ebi-1", { ...baseMsg, ts: now - 5000 });
  mb.push("ebi-1", { ...baseMsg, ts: now - 1000 });
  const snap = mb.pendingSnapshot(now);
  assert.equal(snap.length, 1);
  assert.equal(snap[0]!.id, "ebi-1");
  assert.equal(snap[0]!.count, 2);
  assert.equal(snap[0]!.live, false);
  assert.equal(snap[0]!.oldestAgeMs, 5000); // 最古 = 最初に積んだもの
});

test("clear: 破棄した pending を返す（配送できず失われるものを可視化できる）", () => {
  const mb = new Mailbox();
  mb.push("ebi-1", { ...baseMsg, message: "lost1" });
  mb.push("ebi-1", { ...baseMsg, message: "lost2" });
  const dropped = mb.clear("ebi-1");
  assert.deepEqual(dropped.map((m) => m.message), ["lost1", "lost2"]);
  assert.equal(mb.pendingCount("ebi-1"), 0);
  assert.equal(mb.everSubscribed("ebi-1"), false);
});

test("clear: 待機中の ack を false 解決して破棄する（agent 消滅時に詰まらせない）", async () => {
  const mb = new Mailbox();
  const seqId = mb.push("ebi-1", { ...baseMsg });
  const p = mb.waitForAck("ebi-1", seqId, 5000);
  mb.clear("ebi-1");
  assert.equal(await p, false);
});
