// 起動前チェック（preflight）の評価ロジック。
//
// 設計方針:
// - 判定は**純関数**（evaluatePreflight）。実際の I/O（`--version` 実行 / ファイル存在確認 /
//   env 読み取り）は呼び出し側が行い、その結果を PreflightProbe として渡す。
//   → 単体テストで codex / gemini の実プロセスを起動せずに全分岐を固定できる。
// - 「認証が無い」「必須 env が無い」は **error**（spawn を止める）。
//   「検証済みバージョンと違う」は **warning**（CLI の自動更新で簡単にズレるため止めない。R6 対策）。
// - PR-B ではこの関数を spawn 経路に配線しない（挙動不変）。PR-C / PR-D が
//   GeminiBackend / CodexBackend の起動直前で呼ぶ。

import type { BackendPreflightSpec } from "./types.ts";

/** 実 I/O の結果（呼び出し側が集める）。 */
export interface PreflightProbe {
  /** ホームディレクトリ（requiredFiles の "~/" 展開に使う）。 */
  home: string;
  /** ファイルが存在するか（展開済み絶対パスで問い合わせる）。 */
  fileExists(path: string): boolean;
  /** 起動時 env（envDenyList 適用後の、実際に子へ渡す env）。 */
  env: Record<string, string | undefined>;
  /** `<command> --version` の出力（trim 済み）。取得できなければ null。 */
  version: string | null;
}

export interface PreflightResult {
  /** errors が空なら true（warnings があっても起動してよい）。 */
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** 先頭 "~/" をホームへ展開する（それ以外はそのまま）。 */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}/${path.slice(2)}`;
  return path;
}

/**
 * preflight 仕様と実 I/O 結果から起動可否を判定する純関数。
 *
 * - requiredFiles: 1 つでも欠けたら error（例: codex の ~/.codex/auth.json 未ログイン）。
 * - requiredEnv:   値が無い / 空文字なら error（例: gemini の GOOGLE_CLOUD_PROJECT）。
 * - version:       versionArgs があるのに取得できなければ warning、
 *                  verifiedVersion と一致しなければ warning。
 */
export function evaluatePreflight(
  spec: BackendPreflightSpec,
  probe: PreflightProbe,
): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const raw of spec.requiredFiles) {
    const path = expandHome(raw, probe.home);
    if (!probe.fileExists(path)) {
      errors.push(`必要なファイルがありません: ${path}（未ログインの可能性）`);
    }
  }

  for (const key of spec.requiredEnv) {
    const value = probe.env[key];
    if (value == null || value === "") {
      errors.push(`必要な env がありません: ${key}`);
    }
  }

  if (spec.versionArgs.length > 0) {
    if (probe.version == null || probe.version === "") {
      warnings.push("CLI のバージョンを取得できませんでした（--version が失敗）");
    } else if (spec.verifiedVersion != null && !probe.version.includes(spec.verifiedVersion)) {
      warnings.push(
        `検証済みバージョン ${spec.verifiedVersion} と異なります: ${probe.version}（フラグ仕様が変わっている可能性）`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
