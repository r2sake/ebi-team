// 起動前チェック（preflight）の実 I/O ランナー。
//
// 判定そのものは backends/preflight.ts の純関数 evaluatePreflight() が持つ。
// このファイルは「`<command> --version` を実行する」「認証ファイルの存在を確かめる」という
// 副作用だけを担当し、結果を PreflightProbe に詰めて純関数へ渡す。
//
// 呼び出し箇所は spawn 経路（index.ts の spawnAgent）1 箇所のみ。
// **claude では 1 回も実行されない**（CLAUDE_TRAITS.preflight は requiredFiles / requiredEnv が
// 空で verifiedVersion も null ＝ 確認すべきことが 1 つも無い）。外形ゼロ差分のための設計。

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { evaluatePreflight, type EbiBackend, type PreflightResult } from "./backends/index.ts";

const execFileAsync = promisify(execFile);

/** `--version` 実行のタイムアウト(ms)。 */
const VERSION_TIMEOUT_MS = Number(process.env.EBI_PREFLIGHT_VERSION_TIMEOUT_MS) || 15000;

/**
 * command → version 文字列のキャッシュ。
 * spawn のたびに CLI を起動すると 1 秒前後の遅延が乗るため、プロセス寿命の間は使い回す。
 * バージョン不一致は警告どまり（起動は止めない）なので、CLI の自動更新を取りこぼしても実害はない。
 */
const versionCache = new Map<string, string | null>();

/**
 * この backend に「確認すべきこと」があるか。
 * 無ければ preflight を一切実行しない（claude はここで必ず false になる）。
 */
export function needsPreflight(backend: EbiBackend): boolean {
  const spec = backend.preflight;
  return (
    spec.requiredFiles.length > 0 ||
    spec.requiredEnv.length > 0 ||
    spec.verifiedVersion !== null ||
    spec.loginCheck != null
  );
}

/** `<command> <versionArgs>` を実行して trim 済み出力を返す。失敗したら null。 */
export async function probeVersion(
  command: string,
  versionArgs: readonly string[],
): Promise<string | null> {
  if (versionArgs.length === 0) return null;
  const cached = versionCache.get(command);
  if (cached !== undefined) return cached;
  let result: string | null = null;
  try {
    const { stdout } = await execFileAsync(command, [...versionArgs], {
      timeout: VERSION_TIMEOUT_MS,
    });
    result = stdout.trim();
  } catch {
    result = null;
  }
  versionCache.set(command, result);
  return result;
}

/** テスト用: バージョンキャッシュを空にする。 */
export function clearVersionCache(): void {
  versionCache.clear();
}

/**
 * backend の preflight を実行する。
 * env は「実際に子へ渡す env（envDenyList 適用後）」を渡すこと
 * （gemini の GOOGLE_CLOUD_PROJECT は deny されていないことまで含めて確認したいため）。
 */
export async function runPreflight(
  backend: EbiBackend,
  opts: { command: string; env: Record<string, string | undefined> },
): Promise<PreflightResult> {
  const spec = backend.preflight;
  const version = await probeVersion(opts.command, spec.versionArgs);
  const result = evaluatePreflight(spec, {
    home: homedir(),
    fileExists: (path) => existsSync(path),
    env: opts.env,
    version,
  });

  // 追加の実行チェック（codex の `codex login status`）。
  // 認証ファイルがあっても失効していることがあるため、CLI 自身に聞くのが確実。
  // キャッシュしないのは、失効はサーバ寿命の途中でも起きるため（1 回 300ms 程度）。
  if (spec.loginCheck) {
    const out = await probeCommand(opts.command, spec.loginCheck.args);
    if (out === null || !spec.loginCheck.okPattern.test(out)) {
      result.errors.push(
        `ログインが確認できません（${opts.command} ${spec.loginCheck.args.join(" ")}` +
          `${out === null ? " が失敗" : `: ${out}`}）`,
      );
      result.ok = false;
    }
  }
  return result;
}

/**
 * `<command> <args>` を実行し、**stdout と stderr を連結した** trim 済み出力を返す。失敗なら null。
 * stderr も見るのは `codex login status` が結果を stderr に書くため（0.146.0 実測）。
 */
async function probeCommand(command: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      timeout: VERSION_TIMEOUT_MS,
    });
    return `${stdout}${stderr}`.trim();
  } catch {
    return null;
  }
}
