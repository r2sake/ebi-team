// 制御MCP ブリッジ（control-server.ts）が ebi-team.config.json を見つけるための解決規則。
//
// なぜ専用モジュールなのか（2026-09-05 の実障害）:
//   master の spawn_ebi({role:"imagegen"}) が
//     Invalid arguments ... expected "engineer"
//   で弾かれた。原因は role の zod enum ではなく **config を読めていなかったこと**。
//   ブリッジは `process.cwd()/ebi-team.config.json` を見ていたが、この stdio MCP は
//   claude セッション側の cwd（master なら別プロジェクトのディレクトリ、役割エビなら
//   worktree）で起動される。.ebi-team/*.mcp.json に書いた "cwd" は harness が必ずしも
//   適用しないため、config が見つからず roles が 1 件も登録されず、EBI_ROLES は
//   engineer だけ＝ enum も ["engineer"] だけになっていた（読み込み失敗は
//   loadRawCustomRoles が握り潰すので警告も出ない）。
//
// 方針: 「cwd に依存しない」解決順にする。
//   1. env EBI_CONFIG_PATH（明示指定・最優先）
//   2. process.cwd()/ebi-team.config.json（従来動作。cwd が正しく効いている場合）
//   3. **このモジュール自身の位置**から上へ辿って最初に見つかった ebi-team.config.json
//      （src/mcp/ でも dist/server/mcp/ でも、worktree 配下でもリポジトリの config に届く）
//   4. どれも無ければ 2 のパス（存在しない前提。呼び出し側が警告ログを出す）
//
// このファイルは純関数のみ（fs に触らない）。存在判定は呼び出し側が exists で渡す。

/** config 解決の結果。source は「どの規則で決まったか」（ログ用）。 */
export interface ResolvedConfigPath {
  path: string;
  source: "env" | "cwd" | "module" | "missing";
}

/** 解決に必要な入力（すべて呼び出し側が与える＝テストしやすい）。 */
export interface ResolveConfigPathInput {
  /** env EBI_CONFIG_PATH（未設定なら undefined）。 */
  envPath?: string | undefined;
  /** プロセスの cwd。 */
  cwd: string;
  /** このモジュール（control-server）が置かれたディレクトリ。 */
  moduleDir: string;
  /** ファイルの存在判定（本番は existsSync）。 */
  exists: (path: string) => boolean;
  /** パス結合（本番は node:path の join。テストでは POSIX 固定で渡せる）。 */
  join: (...parts: string[]) => string;
  /** 親ディレクトリ（本番は node:path の dirname）。 */
  dirname: (path: string) => string;
}

/** 探索する config ファイル名。 */
export const CONFIG_FILE_NAME = "ebi-team.config.json";

/** 上方向探索の上限段数（無限ループ防止。src/mcp からリポジトリ root まででも数段）。 */
const MAX_UPWARD_LEVELS = 8;

/**
 * moduleDir から上へ辿って最初に見つかった config のパスを返す（無ければ null）。
 */
function findUpwards(input: ResolveConfigPathInput): string | null {
  let dir = input.moduleDir;
  for (let i = 0; i < MAX_UPWARD_LEVELS; i++) {
    const candidate = input.join(dir, CONFIG_FILE_NAME);
    if (input.exists(candidate)) return candidate;
    const parent = input.dirname(dir);
    if (parent === dir) break; // ルートに到達
    dir = parent;
  }
  return null;
}

/**
 * ebi-team.config.json のパスを cwd 非依存で解決する。
 * 解決順は本ファイル冒頭のコメントを参照。
 */
export function resolveConfigPath(input: ResolveConfigPathInput): ResolvedConfigPath {
  const { envPath, cwd, exists, join } = input;
  if (envPath && envPath.trim() !== "") {
    return { path: envPath, source: "env" };
  }
  const fromCwd = join(cwd, CONFIG_FILE_NAME);
  if (exists(fromCwd)) return { path: fromCwd, source: "cwd" };

  const fromModule = findUpwards(input);
  if (fromModule) return { path: fromModule, source: "module" };

  return { path: fromCwd, source: "missing" };
}
