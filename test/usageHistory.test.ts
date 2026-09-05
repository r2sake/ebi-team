// レート制限使用率の永続化（usage-history.jsonl）のユニットテスト。
//
// 検証する中核:
//   - UsageStore が five_hour / seven_day の used_percentage を「値が変わったときだけ」記録する
//   - 記録には受信時刻・エビ id・model・reset 時刻が載る
//   - rate_limits が無い statusLine では何も記録しない
//   - configure(null) なら実ファイルに書かない / configure したら JSONL 追記＋読み戻せる
//   - summarizeUsage の最大／中央値（奇数件・偶数件・期間外の除外・0 件）
//
// 実行: node --import tsx --test test/usageHistory.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageStore } from "../src/server/usageStore.ts";
import {
  configureUsageHistory,
  flushUsageHistory,
  readUsageHistory,
  summarizeUsage,
  type UsageHistoryRecord,
} from "../src/server/usageHistory.ts";

/** statusLine JSON（rate_limits 付き）の最小形。 */
function statusLine(fhPct: number, sdPct: number, model = "Opus 5") {
  return {
    model: { display_name: model },
    rate_limits: {
      five_hour: { used_percentage: fhPct, resets_at: 1_700_000_000 },
      seven_day: { used_percentage: sdPct, resets_at: 1_700_500_000 },
    },
  };
}

test("値が変わったときだけ記録し、同じ値の再送は追記しない", () => {
  const recs: UsageHistoryRecord[] = [];
  const store = new UsageStore((r) => recs.push(r));

  store.update("master", statusLine(10, 20));
  assert.equal(recs.length, 2); // five_hour + seven_day の初回

  store.update("master", statusLine(10, 20)); // 同じ値 → 追記なし
  assert.equal(recs.length, 2);

  store.update("engineer-1", statusLine(12, 20)); // five_hour だけ変化
  assert.equal(recs.length, 3);
  assert.equal(recs[2]!.window, "five_hour");
  assert.equal(recs[2]!.usedPct, 12);
  assert.equal(recs[2]!.ebiId, "engineer-1");

  store.update("master", statusLine(12, 21)); // seven_day だけ変化
  assert.equal(recs.length, 4);
  assert.equal(recs[3]!.window, "seven_day");
  assert.equal(recs[3]!.usedPct, 21);
});

test("記録に受信時刻・エビ id・model・reset 時刻が載る", () => {
  const recs: UsageHistoryRecord[] = [];
  const before = Date.now();
  new UsageStore((r) => recs.push(r)).update("master", statusLine(1, 2, "Sonnet 5"));
  const after = Date.now();

  const fh = recs.find((r) => r.window === "five_hour")!;
  assert.equal(fh.ebiId, "master");
  assert.equal(fh.model, "Sonnet 5");
  assert.equal(fh.usedPct, 1);
  assert.equal(fh.resetsAt, 1_700_000_000);
  assert.ok(fh.receivedAt >= before && fh.receivedAt <= after);
  assert.equal(fh.ts, new Date(fh.receivedAt).toISOString());

  const sd = recs.find((r) => r.window === "seven_day")!;
  assert.equal(sd.usedPct, 2);
  assert.equal(sd.resetsAt, 1_700_500_000);
});

test("rate_limits が無い / 片方だけ欠けた statusLine では欠けた枠を記録しない", () => {
  const recs: UsageHistoryRecord[] = [];
  const store = new UsageStore((r) => recs.push(r));

  store.update("master", { model: { display_name: "Opus 5" } });
  assert.equal(recs.length, 0);

  // resets_at が欠けている枠は latest 更新もされない仕様に合わせ、記録もしない。
  store.update("master", {
    rate_limits: { five_hour: { used_percentage: 5 }, seven_day: { used_percentage: 6, resets_at: 1 } },
  });
  assert.deepEqual(
    recs.map((r) => r.window),
    ["seven_day"],
  );
});

test("configure(null) ならファイルへ書かない / configure すると JSONL に追記され読み戻せる", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ebi-usage-"));
  try {
    const path = join(dir, "nested", "usage-history.jsonl");

    // 既定の記録関数を使う（configure 前なので書かれない）。
    configureUsageHistory(null);
    new UsageStore().update("master", statusLine(10, 20));
    await flushUsageHistory();
    assert.equal(await readFile(path, "utf8").catch(() => null), null);

    configureUsageHistory(path);
    const store = new UsageStore();
    store.update("master", statusLine(10, 20));
    store.update("master", statusLine(11, 20));
    await flushUsageHistory();

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 3);
    const recs = await readUsageHistory(path);
    assert.equal(recs.length, 3);
    assert.deepEqual(
      recs.map((r) => `${r.window}:${r.usedPct}`),
      ["five_hour:10", "seven_day:20", "five_hour:11"],
    );
  } finally {
    configureUsageHistory(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("readUsageHistory は壊れた行を捨て、ローテート先(.1)も古い順に読む", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ebi-usage-"));
  try {
    const path = join(dir, "usage-history.jsonl");
    const rec = (pct: number, at: number) =>
      JSON.stringify({
        ts: new Date(at).toISOString(),
        receivedAt: at,
        ebiId: "master",
        model: null,
        window: "seven_day",
        usedPct: pct,
        resetsAt: 1,
      });
    await writeFile(`${path}.1`, `${rec(1, 100)}\n{壊れた行\n`, "utf8");
    await writeFile(path, `${rec(2, 200)}\n\n`, "utf8");

    const recs = await readUsageHistory(path);
    assert.deepEqual(
      recs.map((r) => r.usedPct),
      [1, 2],
    );
    // 存在しないパスは空配列（まだ記録が無い状態は異常ではない）。
    assert.deepEqual(await readUsageHistory(join(dir, "none.jsonl")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("summarizeUsage は対象枠・対象期間の最大/中央値を返す", () => {
  const mk = (window: "five_hour" | "seven_day", usedPct: number, receivedAt: number) => ({
    ts: new Date(receivedAt).toISOString(),
    receivedAt,
    ebiId: "master",
    model: null,
    window,
    usedPct,
    resetsAt: 1,
  });
  const recs = [
    mk("seven_day", 10, 1_000),
    mk("seven_day", 90, 3_000),
    mk("seven_day", 50, 2_000),
    mk("five_hour", 99, 2_000), // 枠違いは除外
    mk("seven_day", 5, 500), // 期間外は除外
  ];

  const odd = summarizeUsage(recs, "seven_day", 1_000, 3_000);
  assert.equal(odd.count, 3);
  assert.equal(odd.maxPct, 90);
  assert.equal(odd.medianPct, 50); // 奇数件は中央値そのもの
  assert.equal(odd.latest!.usedPct, 90); // latest は期間内の最新

  const even = summarizeUsage([...recs, mk("seven_day", 20, 2_500)], "seven_day", 1_000, 3_000);
  assert.equal(even.count, 4);
  assert.equal(even.medianPct, 35); // 偶数件は中央 2 値(20,50)の平均

  const none = summarizeUsage(recs, "seven_day", 10_000, 20_000);
  assert.deepEqual(
    { count: none.count, maxPct: none.maxPct, medianPct: none.medianPct, latest: none.latest },
    { count: 0, maxPct: null, medianPct: null, latest: null },
  );
});
