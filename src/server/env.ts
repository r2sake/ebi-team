// リポジトリルートの `.env` を読み込む軽量ローダー（依存なし・自前実装）。
//
// 重要（読み込みタイミング）:
// - このモジュールは **副作用として** import 時に `.env` を process.env へ流し込む。
// - サーバ入口（index.ts）が import する auth.ts / agent.ts などは、モジュール評価時点で
//   `process.env.EBI_*` を定数として読む。ESM の import は宣言順に深さ優先で評価されるため、
//   `import "./env.ts"` を **最初の import 行** に置くことで、それら定数評価より前に .env を適用する。
//
// precedence（標準的な dotenv 準拠）:
// - **既に設定済みの実環境変数を優先**する。.env の値は未設定キーにのみ適用する
//   （`EBI_AUTH_TOKEN=... npm start` のような明示指定が .env に勝つ）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `.env` の 1 行を KEY / VALUE に分解する。対応しない行は null。
 * - 先頭の `export ` は許容（`export KEY=VALUE`）。
 * - `#` 始まりの行と空行は無視。
 * - 値の前後空白は trim。値全体を囲うシングル/ダブルクォートは剥がす。
 */
function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
  const eq = withoutExport.indexOf("=");
  if (eq <= 0) return null;
  const key = withoutExport.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let value = withoutExport.slice(eq + 1).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

/**
 * 指定パス（既定: process.cwd()/.env）の `.env` を読み込み、
 * **未設定キーにのみ** process.env へ適用する。ファイルが無ければ何もしない。
 * @returns 適用したキー名の配列（ログ用）。
 */
export function loadDotenv(path: string = join(process.cwd(), ".env")): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return []; // .env が無いのは正常（環境変数直指定運用）
  }
  const applied: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const kv = parseLine(line);
    if (!kv) continue;
    const [key, value] = kv;
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue; // 実環境変数を優先
    process.env[key] = value;
    applied.push(key);
  }
  return applied;
}

// import 副作用として即実行（index.ts の他 import より前に .env を適用するため）。
export const loadedEnvKeys = loadDotenv();
