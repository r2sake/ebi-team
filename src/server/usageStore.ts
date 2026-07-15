// 使用状況（usage）ストア。
//
// 各エビ(claude) の statusLine コマンドが stdin で受け取る JSON を、EBI_ID 付きで
// 制御API `/control/usage` に best-effort POST してくる。これをエビ別に最新値で保持し、
// アカウント単位の rate_limits（全エビ共通）も latest で保持する。
// WS `usage` のスナップショット生成までを担う（index.ts / control.ts はこれを薄く呼ぶ）。

import type {
  UsageAgent,
  UsageMessage,
  UsageRateLimits,
} from "../shared/protocol.ts";

/** statusLine JSON のうち、利用するフィールドだけを緩く型付けしたもの（best-effort）。 */
interface StatusLineJson {
  model?: { id?: unknown; display_name?: unknown };
  cost?: { total_cost_usd?: unknown };
  context_window?: {
    context_window_size?: unknown;
    used_percentage?: unknown;
    current_usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
      cache_read_input_tokens?: unknown;
    };
  };
  rate_limits?: {
    five_hour?: { used_percentage?: unknown; resets_at?: unknown };
    seven_day?: { used_percentage?: unknown; resets_at?: unknown };
  };
}

/** エビ別に保持する usage エントリ（最新のみ）。 */
interface UsageEntry {
  model: string | null;
  costUsd: number | null;
  contextUsedPct: number | null;
  contextSize: number | null;
  tokens: UsageAgent["tokens"];
  updatedAt: number;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * 使用状況ストア。
 * - update(): statusLine JSON 全体を ebiId 付きで受け、エビ別 usage と
 *   アカウント rate_limits を最新値で更新する。
 * - snapshot(): WS `usage` 用のスナップショット（agents/rateLimits/totalCostUsd）を作る。
 */
export class UsageStore {
  private readonly agents = new Map<string, UsageEntry>();
  /** アカウント単位の rate_limits（全エビ共通・latest）。 */
  private rateLimits: UsageRateLimits = { fiveHour: null, sevenDay: null };

  /**
   * statusLine JSON を取り込む。値検証は最小（best-effort）。不明な ebiId でも受理する。
   * rate_limits が含まれていればアカウント単位で latest を更新する。
   */
  update(ebiId: string, json: unknown): void {
    const j = (json ?? {}) as StatusLineJson;

    const model =
      asStringOrNull(j.model?.display_name) ?? asStringOrNull(j.model?.id);
    const cu = j.context_window?.current_usage;
    const entry: UsageEntry = {
      model,
      costUsd: asNumber(j.cost?.total_cost_usd),
      contextUsedPct: asNumber(j.context_window?.used_percentage),
      contextSize: asNumber(j.context_window?.context_window_size),
      tokens: {
        input: asNumber(cu?.input_tokens),
        output: asNumber(cu?.output_tokens),
        cacheRead: asNumber(cu?.cache_read_input_tokens),
        cacheCreation: asNumber(cu?.cache_creation_input_tokens),
      },
      updatedAt: Date.now(),
    };
    this.agents.set(ebiId, entry);

    // rate_limits はアカウント単位（全エビ共通）。来たものだけ latest で上書きする。
    const rl = j.rate_limits;
    if (rl) {
      const fh = rl.five_hour;
      const sd = rl.seven_day;
      const fhPct = asNumber(fh?.used_percentage);
      const fhReset = asNumber(fh?.resets_at);
      if (fhPct !== null && fhReset !== null) {
        this.rateLimits.fiveHour = { usedPct: fhPct, resetsAt: fhReset };
      }
      const sdPct = asNumber(sd?.used_percentage);
      const sdReset = asNumber(sd?.resets_at);
      if (sdPct !== null && sdReset !== null) {
        this.rateLimits.sevenDay = { usedPct: sdPct, resetsAt: sdReset };
      }
    }
  }

  /** 既知のエビ id 一覧（usage を 1 度でも受けたもの）。 */
  knownIds(): string[] {
    return [...this.agents.keys()];
  }

  /** WS `usage` 用のスナップショットを作る。 */
  snapshot(): UsageMessage {
    const agents: UsageAgent[] = [...this.agents.entries()].map(([id, e]) => ({
      id,
      model: e.model,
      costUsd: e.costUsd,
      contextUsedPct: e.contextUsedPct,
      contextSize: e.contextSize,
      tokens: e.tokens,
      updatedAt: e.updatedAt,
    }));
    const totalCostUsd = agents.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);
    return {
      type: "usage",
      agents,
      rateLimits: this.rateLimits,
      totalCostUsd,
    };
  }
}
