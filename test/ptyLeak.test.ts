// pty master fd（/dev/ptmx）リークの回帰テスト。
//
// node-pty 1.1.0 の macOS 専用パスは spawn 1 回につき /dev/ptmx を 1 本リークし、
// システム上限（kern.tty.ptmx_max=511）に達して spawn が全滅する事故を起こした
// （2026-09-22・詳細は docs/plans/pty-leak-fix-plan.md）。
// node-pty を戻したり別のリークを持ち込んだりしたら、ここで落ちるようにしておく。
//
// 実行: node --import tsx --test test/ptyLeak.test.ts
// darwin 以外は該当コードパスが無いので skip する。

import { test } from "node:test";
import assert from "node:assert/strict";
import * as pty from "node-pty";
import {
  classifyPtmxUsage,
  countPtmxFds,
  formatPtmxLine,
  readPtmxMax,
  startPtmxWatch,
} from "../src/server/ptmxWatch.ts";

const isDarwin = process.platform === "darwin";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("spawn→kill を繰り返しても ptmx を保持し続けない", { skip: !isDarwin }, async () => {
  const before = countPtmxFds();
  const procs: pty.IPty[] = [];
  const exited: boolean[] = [];

  // 同時に大量へ増やさないよう、1 体ずつ立てて即 kill する。
  for (let i = 0; i < 8; i++) {
    const p = pty.spawn("/bin/sh", ["-c", "exec sleep 60"], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: "/tmp",
      env: process.env as Record<string, string>,
    });
    const index = procs.push(p) - 1;
    exited[index] = false;
    p.onData(() => {});
    p.onExit(() => {
      exited[index] = true;
    });
    await sleep(150);
    p.kill();
    await sleep(250);
  }

  // exit 検知の遅れ分だけ待ってから数える（node-pty は exit の 200ms 後に socket を destroy する）。
  for (let i = 0; i < 20 && exited.some((e) => !e); i++) await sleep(100);
  await sleep(500);

  const after = countPtmxFds();
  // 残骸ゼロの保証（テストが落ちても子を残さない）。
  for (const p of procs) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      // 既に死んでいれば何もしない。
    }
  }

  assert.equal(
    after,
    before,
    `ptmx が ${after - before} 本増えたまま戻っていない（spawn ごとのリーク）。` +
      `node-pty のバージョンを確認すること（1.1.0 は既知のリークあり）`,
  );
});

test("classifyPtmxUsage は 60%/80% でしきい値を切り替える", () => {
  assert.equal(classifyPtmxUsage(0, 511), "ok");
  assert.equal(classifyPtmxUsage(306, 511), "ok"); // 59.8%
  assert.equal(classifyPtmxUsage(307, 511), "warn"); // 60.1%
  assert.equal(classifyPtmxUsage(408, 511), "warn"); // 79.8%
  assert.equal(classifyPtmxUsage(409, 511), "error"); // 80.0%
  assert.equal(classifyPtmxUsage(511, 511), "error");
  // max が壊れている場合は判定不能として ok に倒す（監視のせいで落とさない）。
  assert.equal(classifyPtmxUsage(10, 0), "ok");
});

test("formatPtmxLine は生存エビ数との差をリーク疑いとして併記する", () => {
  assert.equal(formatPtmxLine(6, 511, 4), "[ebi-team] ptmx: 6/511 (1.2%) / 生存エビ 4体（リーク疑い 2本）");
  assert.equal(formatPtmxLine(4, 511, null), "[ebi-team] ptmx: 4/511 (0.8%)");
  // 生存エビの方が多く見えるとき（計測タイミングのずれ）は負数にしない。
  assert.ok(formatPtmxLine(2, 511, 4).includes("リーク疑い 0本"));
});

test("readPtmxMax は正の上限を返す", () => {
  const max = readPtmxMax();
  assert.ok(Number.isFinite(max) && max > 0, `ptmx_max が不正: ${max}`);
});

test("startPtmxWatch は stop でタイマを片付ける", () => {
  const handle = startPtmxWatch({ intervalMs: 60_000, liveCount: () => 0 });
  handle.check();
  handle.stop();
  // stop 後にハンドルが残っていないこと（残っていればこのテストプロセスが終了しない）。
  assert.ok(true);
});
