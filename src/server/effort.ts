// 推論努力度（claude の `--effort`）の解決を一元管理する純粋モジュール。
//
// 背景:
//   これまで effort は master 固定エビの args に `--effort medium` と直書きする経路しか
//   無く、役割付きの動的エビ（engineer 等）や model 上書き経由の spawn には一切渡らなかった
//   ＝ claude CLI 既定（medium）で走っていた。Opus 5.5 のように「既定より高い effort で
//   使いたいモデル」が出たとき、spawn 経路ごとに手当てするのは漏れる。
//   そこで「モデル→effort の既定表」を config に 1 つ置き、全 spawn 経路が同じ表を見る形にする。
//
// 設計方針:
//   - I/O を持たない純関数のみ（config.ts / index.ts / roles.ts から読まれる）。
//   - フラグの付与は **extraArgs への追加** で行う。各 backend の buildArgs は extraArgs を
//     常に末尾へ流すので、PTY 経路（backends/claude.ts）も master チャット経路
//     （master/claudeArgs.ts）も同じ 1 か所の解決結果で揃う。
//   - `--effort` が既に明示されている引数列には**絶対に足さない**（二重付与を作らない）。
//   - effort は claude 方言のフラグ。codex / gemini には別語彙（reasoning effort の設定）が
//     あるため、この表は claude backend でしか適用しない（呼び出し側で判定する）。

/** 推論努力度の値域（claude `--effort` の値集合）。 */
export const EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** claude の推論努力度フラグ名。 */
export const EFFORT_FLAG = "--effort";

/** effort 文字列を検証して返す。不正なら throw。 */
export function validateEffort(value: string): Effort {
  if (!(EFFORT_LEVELS as readonly string[]).includes(value)) {
    throw new Error(`effort が不正です: ${value}（許容: ${EFFORT_LEVELS.join(", ")}）`);
  }
  return value as Effort;
}

/** モデル→effort の既定表 1 件（config の effortByModel のエントリ）。 */
export interface EffortRule {
  /** モデル名のパターン。`*` を任意文字列のワイルドカードとして使える。 */
  pattern: string;
  effort: Effort;
}

/** モデル→effort の既定表（config 記載順を保つ）。 */
export type EffortByModel = readonly EffortRule[];

/** 表が無いとき（config 未指定）の値。 */
export const EMPTY_EFFORT_BY_MODEL: EffortByModel = [];

/**
 * ebi-team.config.json の top-level "effortByModel"（{ モデルパターン: effort }）を
 * 検証・正規化する純関数。
 * - undefined / null は「表なし」（空配列）。
 * - オブジェクト以外・値が不正な effort はすべて throw（黙って無視しない）。
 */
export function normalizeEffortByModel(raw: unknown): EffortByModel {
  if (raw === undefined || raw === null) return EMPTY_EFFORT_BY_MODEL;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("effortByModel はオブジェクト（{ モデルパターン: effort }）である必要があります");
  }
  const rules: EffortRule[] = [];
  for (const [pattern, value] of Object.entries(raw as Record<string, unknown>)) {
    if (pattern.trim() === "") {
      throw new Error("effortByModel のキー（モデルパターン）が空です");
    }
    if (typeof value !== "string") {
      throw new Error(`effortByModel."${pattern}" は文字列（${EFFORT_LEVELS.join(" / ")}）である必要があります`);
    }
    try {
      rules.push({ pattern, effort: validateEffort(value) });
    } catch (err) {
      throw new Error(`effortByModel."${pattern}" の ${(err as Error).message}`);
    }
  }
  return rules;
}

/** パターン（`*` ワイルドカード可）がモデル名に一致するか。大文字小文字は区別しない。 */
export function effortPatternMatches(pattern: string, model: string): boolean {
  if (!pattern.includes("*")) return pattern.toLowerCase() === model.toLowerCase();
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "i",
  );
  return re.test(model);
}

/**
 * モデル名から表の effort を引く純関数。
 * 一致が複数あるときの優先は **完全一致 > パターンが長いもの（より具体的）> 記載順**。
 * 一致しなければ null（＝CLI 既定に任せる）。
 */
export function effortForModel(model: string | null | undefined, table: EffortByModel): Effort | null {
  if (!model) return null;
  const exact = table.find((r) => !r.pattern.includes("*") && effortPatternMatches(r.pattern, model));
  if (exact) return exact.effort;
  let best: EffortRule | null = null;
  for (const rule of table) {
    if (!effortPatternMatches(rule.pattern, model)) continue;
    if (best === null || rule.pattern.length > best.pattern.length) best = rule;
  }
  return best?.effort ?? null;
}

/** 引数列に `--effort`（`--effort=high` 形式も含む）が既に明示されているか。 */
export function hasEffortArg(args: readonly string[]): boolean {
  return args.some((a) => a === EFFORT_FLAG || a.startsWith(`${EFFORT_FLAG}=`));
}

/** effort がどこ由来で決まったか（起動ログ用）。 */
export type EffortSource = "args" | "explicit" | "role" | "model";

/** effort 解決の結果。effort が null なら付与しない（CLI 既定）。 */
export interface ResolvedEffort {
  effort: Effort | null;
  source: EffortSource | null;
}

export interface ResolveEffortInput {
  /** 明示指定（spawn オプション / MCP ツール引数）。未検証文字列でよい。 */
  explicit?: string | null;
  /** 役割既定（EbiRole.effort）。 */
  role?: Effort | null;
  /** 解決済みのモデル名（表の引き当てに使う）。 */
  model?: string | null;
  /** モデル→effort の既定表。 */
  table?: EffortByModel;
  /** 既に組み立て済みの追加引数（`--effort` 明示の検出に使う）。 */
  existingArgs?: readonly string[];
}

/**
 * effort の解決（優先順位の SoT）。
 *   引数に明示された `--effort` > 明示 effort オプション > 役割の effort > モデル表 > CLI 既定
 * 先頭 2 つが「明示」で、args 直書きは常に最優先（＝運用者が書いた値を上書きしない）。
 * 戻り値の effort が null なら何も付与しない。
 */
export function resolveEffort(input: ResolveEffortInput): ResolvedEffort {
  if (input.existingArgs && hasEffortArg(input.existingArgs)) {
    return { effort: null, source: "args" };
  }
  if (input.explicit != null && input.explicit !== "") {
    return { effort: validateEffort(input.explicit), source: "explicit" };
  }
  if (input.role) return { effort: input.role, source: "role" };
  const byModel = effortForModel(input.model, input.table ?? EMPTY_EFFORT_BY_MODEL);
  if (byModel) return { effort: byModel, source: "model" };
  return { effort: null, source: null };
}

/** 解決結果を `--effort <値>` の引数列にする（付与しない場合は空配列）。 */
export function effortArgs(resolved: ResolvedEffort): string[] {
  return resolved.effort ? [EFFORT_FLAG, resolved.effort] : [];
}

/** 起動ログ用の 1 行（付与しない場合は null）。例: `effort: high (by model)` */
export function describeEffort(resolved: ResolvedEffort): string | null {
  if (!resolved.effort) return null;
  const by =
    resolved.source === "model"
      ? "by model"
      : resolved.source === "role"
        ? "by role"
        : "explicit";
  return `effort: ${resolved.effort} (${by})`;
}
