// 起動前チェック（preflight）の実 I/O 側。
//
// 判定そのものは preflight.ts の純関数 evaluatePreflight() が持つ（テストでプロセスを
// 起動せず全分岐を固定できるようにするため）。このファイルは「実際にコマンドを叩き、
// ファイルの存在を見る」だけを担う薄い層で、node 組込みに依存する。
//
// 呼ばれるのは spawn 直前（index.ts）で、**非 claude バックエンドのみ**。claude は
// 現状踏襲（preflight を走らせない＝挙動不変）。

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { evaluatePreflight } from "./preflight.ts";
import type { BackendPreflightSpec } from "./types.ts";
import type { PreflightResult } from "./preflight.ts";

export type { PreflightResult } from "./preflight.ts";

/** ログイン状態を追加確認するためのサブコマンド定義（codex の `codex login status` 等）。 */
export interface LoginCheckSpec {
  readonly args: readonly string[];
  /** 正常時の出力に含まれるべきパターン。 */
  readonly okPattern: RegExp;
}

/**
 * コマンドを短いタイムアウトで実行し、**stdout と stderr を連結して** trim して返す。
 * 非 0 終了・spawn 失敗なら null。
 * stderr も見るのは、`codex login status` が結果を **stderr** に書くため（0.146.0 実測）。
 */
function runCapture(command: string, args: readonly string[], timeoutMs: number): string | null {
  const r = spawnSync(command, [...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error || r.status !== 0) return null;
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
}

/**
 * spawn 直前の起動前チェックを実行する。
 *
 * - requiredFiles / requiredEnv / version は evaluatePreflight（純関数）が判定する。
 * - loginCheck を渡した場合は追加で「ログインできているか」を確認し、失敗を **error** にする
 *   （codex は `~/.codex/auth.json` があっても期限切れ等で未ログインになりうるため）。
 */
export function runPreflight(opts: {
  /** 起動バイナリ（PATH 解決前の名前でよい）。 */
  command: string;
  spec: BackendPreflightSpec;
  /** 実際に子へ渡す env（envDenyList 適用後）。 */
  env: Record<string, string | undefined>;
  loginCheck?: LoginCheckSpec | null;
  /** 1 コマンドあたりのタイムアウト（ms）。 */
  timeoutMs?: number;
  home?: string;
}): PreflightResult {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const home = opts.home ?? homedir();
  const version =
    opts.spec.versionArgs.length > 0
      ? runCapture(opts.command, opts.spec.versionArgs, timeoutMs)
      : null;

  const result = evaluatePreflight(opts.spec, {
    home,
    fileExists: (p) => existsSync(p),
    env: opts.env,
    version,
  });

  // `--version` すら取れない＝バイナリが無い/壊れている。純関数側は warning 止まりなので、
  // 実 I/O 側で「そもそも起動できない」を error に格上げする。
  if (opts.spec.versionArgs.length > 0 && version === null) {
    result.errors.push(
      `${opts.command} を実行できません（${opts.command} ${opts.spec.versionArgs.join(" ")} が失敗）`,
    );
  }

  if (opts.loginCheck) {
    const out = runCapture(opts.command, opts.loginCheck.args, timeoutMs);
    if (out === null || !opts.loginCheck.okPattern.test(out)) {
      result.errors.push(
        `ログインが確認できません（${opts.command} ${opts.loginCheck.args.join(" ")}${
          out === null ? " が失敗" : `: ${out}`
        }）`,
      );
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}
