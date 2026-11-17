// pty master fd（/dev/ptmx）の保持本数を監視する保険。
//
// 背景: node-pty 1.1.0 の macOS 専用パス pty_posix_spawn() は捨て番 fd の後始末が
// off-by-one で、spawn 1 回につき /dev/ptmx を 1 本リークしていた（2026-09-22 の事故）。
// システム全体の上限 kern.tty.ptmx_max（既定 511）に達すると pty.spawn が
// "posix_spawnp failed." で失敗し続け、サーバ再起動でしか復旧できない。
//
// node-pty を修正版へ上げたので本来はリークしないが、同種の再発を**枯渇する前に**
// 気付けるよう、起動時と定期で本数をログする。darwin 以外では何もしない（該当コードパスが無い）。
//
// 計測は lsof を呼ばず /dev/fd を走査して fstat する（実測で lsof の結果と完全一致・1ms 未満）。
// 詳細は docs/plans/pty-leak-fix-plan.md。

import { readdirSync, fstatSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** ptmx の major デバイス番号（macOS）。 */
const PTMX_MAJOR = 15;

/** sysctl が読めなかったときに使う既定の上限（macOS の既定値）。 */
export const DEFAULT_PTMX_MAX = 511;

/** 定期チェックの間隔。 */
export const PTMX_WATCH_INTERVAL_MS = 5 * 60 * 1000;

/** warn を出す使用率。 */
export const PTMX_WARN_RATIO = 0.6;

/** error を出す使用率。 */
export const PTMX_ERROR_RATIO = 0.8;

export type PtmxLevel = "ok" | "warn" | "error";

/**
 * 使用率から深刻度を決める純関数。
 * count/max が error 比率以上なら "error"、warn 比率以上なら "warn"、それ未満は "ok"。
 * max が 0 以下（sysctl が壊れている等）のときは判定できないので "ok" に倒す。
 */
export function classifyPtmxUsage(
  count: number,
  max: number,
  warnRatio: number = PTMX_WARN_RATIO,
  errorRatio: number = PTMX_ERROR_RATIO,
): PtmxLevel {
  if (max <= 0) return "ok";
  const ratio = count / max;
  if (ratio >= errorRatio) return "error";
  if (ratio >= warnRatio) return "warn";
  return "ok";
}

/**
 * 自プロセスが保持している /dev/ptmx の本数を数える。
 * darwin 以外は常に 0（該当するリーク経路が無く、rdev の major も別体系のため）。
 */
export function countPtmxFds(): number {
  if (process.platform !== "darwin") return 0;
  let count = 0;
  let names: string[];
  try {
    names = readdirSync("/dev/fd");
  } catch {
    return 0;
  }
  for (const name of names) {
    const fd = Number(name);
    if (!Number.isInteger(fd)) continue;
    try {
      const st = fstatSync(fd);
      // rdev の上位 8bit が major。ptmx はキャラクタデバイスで major == 15。
      if (st.isCharacterDevice() && (st.rdev >> 24) === PTMX_MAJOR) count += 1;
    } catch {
      // 走査中に閉じられた fd は無視する。
    }
  }
  return count;
}

/**
 * システム全体の pty 上限（kern.tty.ptmx_max）を読む。読めなければ既定値。
 * 値は起動中に変わらない前提で、呼び出し側が一度だけ読んでキャッシュする。
 */
export function readPtmxMax(): number {
  if (process.platform !== "darwin") return DEFAULT_PTMX_MAX;
  try {
    const out = execFileSync("/usr/sbin/sysctl", ["-n", "kern.tty.ptmx_max"], {
      encoding: "utf8",
      timeout: 2000,
    });
    const n = Number(out.trim());
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_PTMX_MAX;
  } catch {
    return DEFAULT_PTMX_MAX;
  }
}

/**
 * 1 回分のログ行を組み立てる純関数（テスト可能にするため切り出す）。
 * live を渡すと「生存エビ数」との差＝リーク疑いの本数も併記する。
 */
export function formatPtmxLine(count: number, max: number, live: number | null): string {
  const pct = max > 0 ? ((count / max) * 100).toFixed(1) : "?";
  const suffix =
    live === null ? "" : ` / 生存エビ ${live}体（リーク疑い ${Math.max(0, count - live)}本）`;
  return `[ebi-team] ptmx: ${count}/${max} (${pct}%)${suffix}`;
}

export interface PtmxWatchOptions {
  /** 生存エビ数を返す（ログに差分を併記するため）。省略時は併記しない。 */
  liveCount?: () => number;
  /** チェック間隔。既定 5 分。 */
  intervalMs?: number;
  /** 閾値超えを master などへ通知する先（任意）。 */
  onAlert?: (level: Exclude<PtmxLevel, "ok">, message: string) => void;
}

export interface PtmxWatchHandle {
  /** 監視を止める。 */
  stop(): void;
  /** 即時に 1 回チェックする（テスト・起動時ログ用）。 */
  check(): void;
}

/**
 * 起動時に 1 回、以降 intervalMs ごとに ptmx 本数をログする。
 * darwin 以外では何もしない no-op ハンドルを返す。
 * タイマは unref() 済みでサーバの終了を妨げない。
 */
export function startPtmxWatch(opts: PtmxWatchOptions = {}): PtmxWatchHandle {
  if (process.platform !== "darwin") {
    return { stop: () => {}, check: () => {} };
  }
  const max = readPtmxMax();
  const check = (): void => {
    const count = countPtmxFds();
    const live = opts.liveCount ? opts.liveCount() : null;
    const line = formatPtmxLine(count, max, live);
    const level = classifyPtmxUsage(count, max);
    if (level === "error") {
      const msg = `${line} ★上限に接近。このままだと spawn が "posix_spawnp failed." で失敗します`;
      console.error(msg);
      opts.onAlert?.("error", msg);
    } else if (level === "warn") {
      const msg = `${line} ※使用率が高めです`;
      console.warn(msg);
      opts.onAlert?.("warn", msg);
    } else {
      console.log(line);
    }
  };
  check();
  const timer = setInterval(check, opts.intervalMs ?? PTMX_WATCH_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer), check };
}
