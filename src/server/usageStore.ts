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
import {
  recordUsageHistory,
  type UsageHistoryRecord,
  type UsageWindow,
} from "./usageHistory.ts";

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
   * @param history 履歴の追記関数（既定は usageHistory の JSONL 追記）。
   *   テストが実ファイルへ書かずに検証できるよう差し替え可能にしてある。
   */
  constructor(
    private readonly history: (rec: UsageHistoryRecord) => void = recordUsageHistory,
  ) {}

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
        const prev = this.rateLimits.fiveHour;
        this.rateLimits.fiveHour = { usedPct: fhPct, resetsAt: fhReset };
        this.persistIfChanged("five_hour", prev, fhPct, fhReset, ebiId, model, entry.updatedAt);
      }
      const sdPct = asNumber(sd?.used_percentage);
      const sdReset = asNumber(sd?.resets_at);
      if (sdPct !== null && sdReset !== null) {
        const prev = this.rateLimits.sevenDay;
        this.rateLimits.sevenDay = { usedPct: sdPct, resetsAt: sdReset };
        this.persistIfChanged("seven_day", prev, sdPct, sdReset, ebiId, model, entry.updatedAt);
      }
    }
  }

  /**
   * 値（使用率 or リセット時刻）が前回と変わったときだけ履歴へ 1 行残す。
   * statusLine は数秒〜数十秒おきに同じ値を送ってくるため、無条件追記だとログが肥大化する。
   */
  private persistIfChanged(
    window: UsageWindow,
    prev: { usedPct: number; resetsAt: number } | null,
    usedPct: number,
    resetsAt: number,
    ebiId: string,
    model: string | null,
    receivedAt: number,
  ): void {
    if (prev && prev.usedPct === usedPct && prev.resetsAt === resetsAt) return;
    this.history({
      ts: new Date(receivedAt).toISOString(),
      receivedAt,
      ebiId,
      model,
      window,
      usedPct,
      resetsAt,
    });
  }

  /**
   * ヘッドレス master（ui:"chat"）の usage を取り込む。
   *
   * chat モードには statusLine が無いため /control/usage は飛んでこない。代わりに
   * MasterSession が `turnEnd` の usage（ターン最後の assistant の message.usage ÷
   * result.modelUsage[model].contextWindow）を渡してくる（設計書 §8-R3）。
   * 保持形は statusLine 由来のエントリと**同一**なので、ダッシュボードも contextGuard も
   * 入力インターフェースを変えずに済む。
   */
  updateFromChat(
    ebiId: string,
    input: {
      model: string | null;
      costUsd: number | null;
      contextUsedPct: number | null;
      contextSize: number | null;
      tokens: UsageEntry["tokens"];
    },
  ): void {
    this.agents.set(ebiId, {
      model: input.model,
      costUsd: input.costUsd,
      contextUsedPct: input.contextUsedPct,
      contextSize: input.contextSize,
      tokens: input.tokens,
      updatedAt: Date.now(),
    });
  }

  /**
   * アカウント単位のレート制限枠を取り込む（chat モードの `rate_limit_event` 由来）。
   * statusLine 経路と同じく latest 上書き＋変化時のみ履歴追記。
   */
  updateRateLimits(
    ebiId: string,
    limits: Partial<UsageRateLimits>,
    model: string | null = null,
  ): void {
    const now = Date.now();
    if (limits.fiveHour) {
      const prev = this.rateLimits.fiveHour;
      this.rateLimits.fiveHour = limits.fiveHour;
      this.persistIfChanged("five_hour", prev, limits.fiveHour.usedPct, limits.fiveHour.resetsAt, ebiId, model, now);
    }
    if (limits.sevenDay) {
      const prev = this.rateLimits.sevenDay;
      this.rateLimits.sevenDay = limits.sevenDay;
      this.persistIfChanged("seven_day", prev, limits.sevenDay.usedPct, limits.sevenDay.resetsAt, ebiId, model, now);
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
