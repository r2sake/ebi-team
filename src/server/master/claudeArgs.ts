// ClaudeHeadlessBrain の「起動引数の組み立て」「env の deny」「起動前チェック」の純関数群。
//
// 実測 SoT: docs/poc/master-headless-poc-2026-09-05.md §1（そのまま通った引数列）/ §5-H / §5-I
// I/O は一切しない（プロセスも起動しないしファイルも読まない）。テストで全分岐を固定できるようにする。

/**
 * master プロセスの env から**必ず落とす**キー（設計書 §8-R2）。
 *
 * 目的は 1 つ: **従量課金経路への転落を機械的に止める**こと。
 * 非 `--bare` の `-p` はサブスク OAuth を読む（公式 docs 明記）が、`ANTHROPIC_API_KEY` 等が
 * env に残っていると API 経路を掴む余地があるため、親 env の継承分から明示的に削除する。
 * gemini の `GOOGLE_CLOUD_PROJECT` 事故（起動必須 env を deny して起動不能にした）と
 * 同型の失敗を避けるため、**起動に必要な env は 1 つも入れない**こと。
 */
export const MASTER_ENV_DENY_LIST: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

/**
 * 付いていたら**起動を拒否する**引数（設計書 §8-R2）。
 * `--bare` を付けた瞬間 OAuth（サブスク）を読まなくなり、`ANTHROPIC_API_KEY` 経由の
 * 従量課金に落ちる。config の args / EBI_ARGS から混入しうるので機械的に弾く。
 */
export const MASTER_FORBIDDEN_ARGS: readonly string[] = ["--bare"];

/**
 * master の既定モデル。
 * **CLI の既定モデルは opus ではない**（PoC 実測で `claude-fable-5-1`）ので、明示しないと
 * master が意図しないモデルで走る。設計書 §5-H の修正点。
 */
export const DEFAULT_CLAUDE_MASTER_MODEL = "opus";

export interface ClaudeHeadlessArgsInput {
  model: string | null;
  permissionMode: string | null;
  systemPrompt: string | null;
  mcpConfigPath: string | null;
  resumeSessionId: string | null;
  /**
   * `--include-partial-messages`（トークン単位ストリーム）を付けるか。
   * **既定 false**: PoC が実測で通した引数列には含まれていない（未検証）。
   * 逐次表示が要る PR-M3 で true に切り替える。
   */
  includePartialMessages?: boolean;
  extraArgs: readonly string[];
}

/**
 * `claude -p` ヘッドレス master の起動引数を組み立てる純関数。
 *
 * 基幹部は PoC でそのまま通ったもの（docs/poc/… §1）:
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *          --replay-user-messages --mcp-config <path> --strict-mcp-config
 *          --permission-mode auto --append-system-prompt <role> --model opus
 *
 * 不変条件:
 * - `--bare` は**絶対に付けない**（付いていたら preflight が起動を拒否する）。
 * - `--permission-prompts none` は付けない（AskUserQuestion がツール一覧から消え、
 *   「ボスに聞く」という master の中核機能が死ぬ・設計書 §1.1）。
 * - extraArgs は常に末尾（既存 EbiBackend.buildArgs と同じ規約）。
 */
export function buildClaudeHeadlessArgs(input: ClaudeHeadlessArgsInput): string[] {
  const args: string[] = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--replay-user-messages",
  ];
  if (input.includePartialMessages) args.push("--include-partial-messages");
  if (input.mcpConfigPath) {
    // --strict-mcp-config を付けても ebi-control は connected になる（PoC §2.1）。
    args.push("--mcp-config", input.mcpConfigPath, "--strict-mcp-config");
  }
  if (input.permissionMode) args.push("--permission-mode", input.permissionMode);
  if (input.systemPrompt) args.push("--append-system-prompt", input.systemPrompt);
  args.push("--model", input.model ?? DEFAULT_CLAUDE_MASTER_MODEL);
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  args.push(...input.extraArgs);
  return args;
}

/**
 * 親 env から deny 対象キーを落とす純関数。
 * 値が undefined のキーもキーごと削除する（`{K: undefined}` が残ると spawn 実装によっては
 * 空文字で渡ってしまうため）。
 */
export function applyMasterEnvDenyList(
  parentEnv: Record<string, string | undefined>,
  denyList: readonly string[] = MASTER_ENV_DENY_LIST,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const deny = new Set(denyList);
  for (const [k, v] of Object.entries(parentEnv)) {
    if (deny.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface MasterPreflightResult {
  /** errors が空なら true（warnings があっても起動してよい）。 */
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface MasterPreflightInput {
  /** 実際に spawn する引数列（extraArgs 込み）。 */
  args: readonly string[];
  /** 実際に子へ渡す env（**deny list 適用後**）。 */
  childEnv: Record<string, string | undefined>;
  /** 親 env（deny 適用前）。落としたことを警告に出すためだけに使う。省略可。 */
  parentEnv?: Record<string, string | undefined>;
  denyList?: readonly string[];
}

/**
 * 起動前チェック（純関数）。
 *
 * error（起動を止める）:
 *  - `--bare` が引数に含まれる（従量課金への転落）
 *  - deny 対象の env が**子 env に残っている**（deny list の適用漏れ＝実装バグの検出）
 * warning（止めない）:
 *  - 親 env に deny 対象があった（落としたことを運用者に知らせる）
 *  - `--permission-prompts none`（AskUserQuestion が消える）
 */
export function evaluateMasterPreflight(input: MasterPreflightInput): MasterPreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const denyList = input.denyList ?? MASTER_ENV_DENY_LIST;

  for (const forbidden of MASTER_FORBIDDEN_ARGS) {
    const hit = input.args.some((a) => a === forbidden || a.startsWith(`${forbidden}=`));
    if (hit) {
      errors.push(
        `${forbidden} は master では使用禁止です（サブスク OAuth を読まなくなり従量課金に落ちます）`,
      );
    }
  }

  for (const key of denyList) {
    // 値の有無ではなく**キーの存在**で判定する（空文字や undefined で残っていても適用漏れ）。
    if (Object.prototype.hasOwnProperty.call(input.childEnv, key)) {
      errors.push(`子 env に ${key} が残っています（deny list の適用漏れ）`);
    }
    const parent = input.parentEnv?.[key];
    if (parent != null && parent !== "") {
      warnings.push(`親 env の ${key} を master プロセスから落としました`);
    }
  }

  const pp = input.args.indexOf("--permission-prompts");
  if (pp >= 0 && input.args[pp + 1] === "none") {
    warnings.push(
      "--permission-prompts none は AskUserQuestion をツール一覧から取り除きます（master では非推奨）",
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * `system/init` の自己申告からサブスク経路を検証する純関数（設計書修正点 I）。
 *
 * PoC 実測で init が `apiKeySource: "none"` を返した＝**API キー無しの OAuth で走っている**
 * ことをプロセス自身が申告する。`none` 以外なら従量課金経路に載っている疑いがあるので
 * 起動失敗として扱う（`--bare` 拒否 + env deny に加えた三重目の歯止め）。
 */
export function evaluateInitApiKeySource(apiKeySource: unknown): MasterPreflightResult {
  if (apiKeySource === "none") return { ok: true, errors: [], warnings: [] };
  if (apiKeySource == null) {
    return {
      ok: true,
      errors: [],
      warnings: ["system/init に apiKeySource がありません（CLI のバージョン差の可能性）"],
    };
  }
  return {
    ok: false,
    errors: [
      `apiKeySource が "none" ではありません: ${String(apiKeySource)}（サブスクではなく API キー経路で走っている疑い）`,
    ],
    warnings: [],
  };
}
