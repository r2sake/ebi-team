// master コンテキスト枯渇ガード（context-guard）。
//
// 目的: master セッションのコンテキスト使用率を監視し、自動 compact に食われて PM 文脈が
// 消える前に「促す」通知を出す。**compact も /clear も ebi-team は実行しない**（既存方針）。
//
// 設計: docs/plans/context-guard-plan.md
// 観測値の供給元は statusLine JSON（`context_window.used_percentage` / `context_window_size`）で、
// `usageStore` が既に抽出済み。本モジュールは **時計も registry も broadcast も知らない**
// 純粋なステートマシンで、判定結果は onNotice コールバックだけに出す（テスト容易性を型で強制）。
//
// 段階（ボス裁定 X-1）:
//   soft=65% / notify(hard)=70% / critical=85%
// 発火の約束:
//   - 65% 到達の瞬間、キリの良し悪しに関係なく **予告**（advance）を 1 回出す。
//     master はこれをそのままボスへ転記する（`advance` の本文に転記用の定型文が入っている）。
//   - その後キリが良くなった（配下 dynamic エビ全員 idle かつ master idle）時点で
//     **/clear 促し**（quiescent）を 1 回出す（X-5: soft は保留して次のキリで発火）。
//   - 70% 超（hard）はキリの良し悪しを問わず 1 回。
//   - 85% 超（critical）は cooldown 経過ごとに再通知（本当に危ないので）。
//   - いずれも「使用率が下がらない限り 1 回」。下降でレベルが戻れば状態はリセットされ再武装する。

import type { UsageAgent, AgentRecord } from "../shared/protocol.ts";

/** ガードのレベル（使用率の帯）。 */
export type GuardLevel = "none" | "soft" | "hard" | "critical";

/** 通知の種別。level とは独立（soft 帯で advance と quiescent の 2 種が出るため）。 */
export type GuardNoticeKind = "advance" | "quiescent" | "hard" | "critical" | "health";

export interface ContextGuardConfig {
  /** 無効化フラグ（既定 true）。 */
  enabled: boolean;
  /** 予告を出す使用率（既定 65）。 */
  softPct: number;
  /** 無条件通知の使用率（既定 70）。 */
  hardPct: number;
  /** 危険域の使用率（既定 85）。 */
  criticalPct: number;
  /** レベル再武装の下げ幅マージン（pt・既定 5）。整数刻みのチャタリング吸収。 */
  rearmMarginPct: number;
  /** critical の再通知間隔（ms・既定 10 分）。 */
  cooldownMs: number;
  /** usage がこの時間より古ければ判定をスキップ（ms・既定 15 分）。 */
  staleMs: number;
  /** 監視対象エビ id（既定 "master"）。 */
  targetId: string;
  /** contextUsedPct が null のまま連続でこの回数受けたら健全性 notice を 1 回出す。 */
  nullHealthThreshold: number;
}

export const DEFAULT_CONTEXT_GUARD_CONFIG: ContextGuardConfig = {
  enabled: true,
  softPct: 65,
  hardPct: 70,
  criticalPct: 85,
  rearmMarginPct: 5,
  cooldownMs: 600_000,
  staleMs: 900_000,
  targetId: "master",
  nullHealthThreshold: 20,
};

/** 発火した 1 件の通知。text は UI notice / master inject の両方でそのまま使う。 */
export interface GuardNotice {
  kind: GuardNoticeKind;
  level: GuardLevel;
  usedPct: number | null;
  contextSize: number | null;
  /** 判定時点でキリが良かったか。 */
  quiescent: boolean;
  /** 判定時点で走行中（busy）の dynamic エビ数。 */
  busyDynamic: number;
  text: string;
}

/** 3 桁区切り。toLocaleString はロケール依存でテストが揺れるので自前で持つ。 */
function comma(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 上限（context_window_size）の表示。未取得なら「不明」。 */
function limitLabel(size: number | null): string {
  return size === null ? "上限不明" : `${comma(size)} tokens`;
}

/**
 * キリが良いか（quiescence）。ボス裁定 X-3:
 * 「配下 dynamic エビ全員 idle **かつ** master idle」。
 * target が registry に居なければ判定不能なので false（キリが良いとは言い切らない）。
 */
export function isQuiescent(agents: AgentRecord[], targetId = "master"): boolean {
  const target = agents.find((a) => a.id === targetId);
  if (!target || target.status !== "idle") return false;
  return agents.every((a) => a.kind !== "dynamic" || a.status === "idle");
}

/** 走行中（busy）の dynamic エビ数。通知文に埋め込む。 */
export function countBusyDynamic(agents: AgentRecord[]): number {
  return agents.filter((a) => a.kind === "dynamic" && a.status === "busy").length;
}

const LEVEL_ORDER: Record<GuardLevel, number> = { none: 0, soft: 1, hard: 2, critical: 3 };

/** /clear 前のハンドオフ手順（設計 §4）。通知文の末尾に共通で付ける。 */
const HANDOFF_STEPS = [
  "【/clear 前のハンドオフ手順】",
  "1. ops/daily-handoff/<YYYY-MM-DD>-master-handoff.md に以下を書き出す:",
  "   - 進行中のボス依頼（要件・承認状況）",
  "   - 生存している配下エビの一覧（list_ebi の結果をそのまま貼る）と各自の担当タスク",
  "   - 未回収の reply_to_master（待っている報告）",
  "   - 次にやること（箇条書き 3〜5 行）",
  "2. ボスに /clear を提案する。",
  "3. 切り直し後、最初に上記 md を読み込んで PM 文脈を復元する。",
].join("\n");

/**
 * コンテキスト枯渇ガード本体。
 * `observe()` を usage 取り込みのたびに呼ぶ。副作用は onNotice のみ（同期）。
 */
export class ContextGuard {
  private readonly cfg: ContextGuardConfig;
  private readonly onNotice: (n: GuardNotice) => void;

  private currentLevel: GuardLevel = "none";
  /** 発火済みのレベル（下降でリセットされる）。 */
  private readonly fired = new Set<GuardLevel>();
  /** 65% 予告を出したか（soft 帯 1 回）。 */
  private advanceFired = false;
  /** 「キリが付いたら /clear を促す」通知の武装状態（X-5 の保留分）。 */
  private quiescentArmed = false;
  private quiescentFired = false;
  /** critical の最終通知時刻（cooldown 用）。 */
  private criticalNotifiedAt = 0;
  /** contextUsedPct が null のまま連続で受けた回数（無言の機能停止検出）。 */
  private nullStreak = 0;
  private healthNotified = false;

  constructor(cfg: Partial<ContextGuardConfig> = {}, onNotice: (n: GuardNotice) => void) {
    this.cfg = { ...DEFAULT_CONTEXT_GUARD_CONFIG, ...cfg };
    this.onNotice = onNotice;
  }

  /** テスト・デバッグ用の内部状態参照。 */
  level(): GuardLevel {
    return this.currentLevel;
  }

  config(): Readonly<ContextGuardConfig> {
    return this.cfg;
  }

  /**
   * usage 取り込みのたびに呼ぶ。判定と発火は同期・副作用は onNotice のみ。
   * @param usage 監視対象（既定 master）の usage エントリ。id が targetId でなければ無視。
   * @param agents registry のスナップショット（キリ判定用）。
   * @param now 現在時刻（テストから注入するため引数）。
   */
  observe(usage: UsageAgent, agents: AgentRecord[], now: number = Date.now()): void {
    if (!this.cfg.enabled) return;
    if (usage.id !== this.cfg.targetId) return;

    // stale（statusLine が長時間走っていない）: 古い値で上げも下げもしない。
    if (now - usage.updatedAt > this.cfg.staleMs) return;

    // null は「未知」であって「0%」ではない。判定はスキップし、レベルは据え置く。
    if (usage.contextUsedPct === null) {
      this.nullStreak += 1;
      if (!this.healthNotified && this.nullStreak >= this.cfg.nullHealthThreshold) {
        this.healthNotified = true;
        this.emit({
          kind: "health",
          level: this.currentLevel,
          usedPct: null,
          contextSize: usage.contextSize,
          quiescent: false,
          busyDynamic: countBusyDynamic(agents),
          text:
            `[context-guard] ${this.cfg.targetId} の usage を ${this.nullStreak} 回連続で受けましたが、` +
            "コンテキスト使用率（context_window.used_percentage）が常に空でした。\n" +
            "Claude Code の statusLine JSON のスキーマが変わり、枯渇ガードが無言で停止している可能性があります。\n" +
            "→ ~/.claude/statusline-command.sh が送る JSON を確認してください（監視は停止したまま動き続けます）。",
        });
      }
      return;
    }
    this.nullStreak = 0;

    const pct = usage.contextUsedPct;
    const prev = this.currentLevel;
    const next = this.nextLevel(pct, prev);
    if (next !== prev) this.transition(prev, next);
    this.currentLevel = next;

    const quiescent = isQuiescent(agents, this.cfg.targetId);
    const busyDynamic = countBusyDynamic(agents);
    const base = { level: next, usedPct: pct, contextSize: usage.contextSize, quiescent, busyDynamic };

    // (1) soft 帯へ入った瞬間の「予告」。キリの良し悪しに関係なく 1 回。
    //     70% 以上へ一足飛びに上がった場合も、soft を跨いだ以上は予告扱いで武装だけはする。
    if (LEVEL_ORDER[next] >= LEVEL_ORDER.soft && !this.advanceFired) {
      this.advanceFired = true;
      this.quiescentArmed = true;
      this.emit({ ...base, kind: "advance", text: this.advanceText(pct, usage.contextSize, busyDynamic) });
    }

    // (2) レベル上昇時の通知（hard / critical）。同レベル内では鳴らない。
    if (next === "hard" && !this.fired.has("hard")) {
      this.fired.add("hard");
      this.emit({ ...base, kind: "hard", text: this.hardText(pct, usage.contextSize, busyDynamic) });
    }
    if (next === "critical") {
      const first = !this.fired.has("critical");
      if (first || now - this.criticalNotifiedAt >= this.cfg.cooldownMs) {
        this.fired.add("critical");
        this.criticalNotifiedAt = now;
        this.emit({ ...base, kind: "critical", text: this.criticalText(pct, usage.contextSize, busyDynamic) });
      }
    }

    // (3) 保留していた「キリが付いたので /clear を促す」通知（X-5）。soft 以上かつ quiescent で 1 回。
    if (this.quiescentArmed && !this.quiescentFired && quiescent && LEVEL_ORDER[next] >= LEVEL_ORDER.soft) {
      this.quiescentFired = true;
      this.emit({ ...base, kind: "quiescent", text: this.quiescentText(pct, usage.contextSize) });
    }
  }

  /**
   * 次のレベルを決める。上昇は即時、下降は rearmMarginPct 分の下げ幅を要求する
   * （used_percentage が整数刻みなので 69↔70 の往復でチャタリングしないため）。
   */
  private nextLevel(pct: number, prev: GuardLevel): GuardLevel {
    const raw = this.rawLevel(pct);
    if (LEVEL_ORDER[raw] >= LEVEL_ORDER[prev]) return raw;
    // 下降: 現レベルの閾値から margin 分下回るまでは据え置く。
    const th = this.thresholdOf(prev);
    if (pct >= th - this.cfg.rearmMarginPct) return prev;
    return raw;
  }

  private rawLevel(pct: number): GuardLevel {
    if (pct >= this.cfg.criticalPct) return "critical";
    if (pct >= this.cfg.hardPct) return "hard";
    if (pct >= this.cfg.softPct) return "soft";
    return "none";
  }

  private thresholdOf(level: GuardLevel): number {
    if (level === "critical") return this.cfg.criticalPct;
    if (level === "hard") return this.cfg.hardPct;
    if (level === "soft") return this.cfg.softPct;
    return 0;
  }

  /** レベル遷移時の状態更新。下降した分の「発火済み」を捨てて再武装する。 */
  private transition(prev: GuardLevel, next: GuardLevel): void {
    if (LEVEL_ORDER[next] >= LEVEL_ORDER[prev]) return; // 上昇時は何も捨てない
    for (const lv of ["hard", "critical"] as const) {
      if (LEVEL_ORDER[lv] > LEVEL_ORDER[next]) this.fired.delete(lv);
    }
    if (next === "none") {
      // /clear や compact で落ちた＝一巡完了。soft 帯の状態も丸ごとリセットする。
      this.advanceFired = false;
      this.quiescentArmed = false;
      this.quiescentFired = false;
      this.criticalNotifiedAt = 0;
    }
  }

  private emit(n: GuardNotice): void {
    this.onNotice(n);
  }

  // ===== 通知文（日本語の定型文）=====

  /**
   * 65% 予告。**master がそのままボスへ転記できる定型文**を本文に含めるのがボス要件。
   * 数値・上限・走行中エビ数を埋め込む。
   */
  private advanceText(pct: number, size: number | null, busyDynamic: number): string {
    return [
      `[context-guard] ${this.cfg.targetId} のコンテキスト使用率が ${this.cfg.softPct}% に達しました` +
        `（現在 ${pct}% / ${limitLabel(size)}）。走行中の動的エビ: ${busyDynamic} 匹。`,
      "",
      "→ まず以下をそのままボスへ伝えてください（転記用・そのまま貼れます）:",
      "--- ここから ---",
      `コンテキストが ${pct}%（上限 ${limitLabel(size)}）に達しました。走行中のエビは ${busyDynamic} 匹です。` +
        "キリが良くなるよう（走行中タスクの区切り・報告集約）進めてください。キリが付いたら /clear を促します。",
      "--- ここまで ---",
      "",
      "→ 併せて、走行中タスクの区切りと配下エビの報告集約を進めてください。",
      `キリが付いた（配下 dynamic エビが全員 idle かつ ${this.cfg.targetId} も idle）時点で、` +
        "改めて /clear を促す通知を出します。",
    ].join("\n");
  }

  /** キリが付いた時の /clear 促し（X-5 の保留分の発火）。 */
  private quiescentText(pct: number, size: number | null): string {
    return [
      `[context-guard] キリが付きました（配下 dynamic エビは全員 idle・${this.cfg.targetId} も idle）。` +
        `コンテキスト使用率は ${pct}%（${limitLabel(size)}）です。`,
      "→ ボスに「ここで /clear（セッション切り直し）しませんか」と提案してください。",
      "→ 提案の前に、切り直し後に文脈を復元できるよう以下のハンドオフ要約を残すこと。",
      "",
      HANDOFF_STEPS,
    ].join("\n");
  }

  /** 70% 超（無条件）。 */
  private hardText(pct: number, size: number | null, busyDynamic: number): string {
    return [
      `[context-guard] ${this.cfg.targetId} のコンテキスト使用率が ${this.cfg.hardPct}% を超えました` +
        `（現在 ${pct}% / ${limitLabel(size)}）。走行中の動的エビ: ${busyDynamic} 匹。`,
      "このまま進むと自動 compact が走り、PM としての文脈（配下エビの状況・進行中の依頼）が失われます。",
      "→ 走行中タスクの区切りを待たず、ボスに /clear を提案してください。",
      "→ /clear の前に必ず以下のハンドオフ要約を残すこと。",
      "",
      HANDOFF_STEPS,
    ].join("\n");
  }

  /** 85% 超（危険域・cooldown 経過で再通知）。 */
  private criticalText(pct: number, size: number | null, busyDynamic: number): string {
    return [
      `[context-guard] ${this.cfg.targetId} のコンテキスト使用率が ${this.cfg.criticalPct}% を超えました` +
        `（現在 ${pct}% / ${limitLabel(size)}）。compact が目前です。走行中の動的エビ: ${busyDynamic} 匹。`,
      "→ 今すぐハンドオフ要約を書き出し、ボスに /clear を強く促してください。",
      "",
      HANDOFF_STEPS,
    ].join("\n");
  }
}

/** `off` / `0` / `false` を無効とみなす（EBI_IDLE_NOTIFY と同じ判定）。 */
function envEnabled(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return !["off", "0", "false"].includes(v.trim().toLowerCase());
}

function envNumber(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** env から設定を読む（既定 on・閾値は上書き可能）。 */
export function contextGuardConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ContextGuardConfig {
  const d = DEFAULT_CONTEXT_GUARD_CONFIG;
  return {
    enabled: envEnabled(env.EBI_CTX_GUARD, d.enabled),
    softPct: envNumber(env.EBI_CTX_GUARD_SOFT_PCT, d.softPct),
    hardPct: envNumber(env.EBI_CTX_GUARD_HARD_PCT, d.hardPct),
    criticalPct: envNumber(env.EBI_CTX_GUARD_CRITICAL_PCT, d.criticalPct),
    rearmMarginPct: envNumber(env.EBI_CTX_GUARD_REARM_MARGIN_PCT, d.rearmMarginPct),
    cooldownMs: envNumber(env.EBI_CTX_GUARD_COOLDOWN_MS, d.cooldownMs),
    staleMs: envNumber(env.EBI_CTX_GUARD_STALE_MS, d.staleMs),
    targetId: env.EBI_CTX_GUARD_TARGET?.trim() || d.targetId,
    nullHealthThreshold: envNumber(env.EBI_CTX_GUARD_NULL_HEALTH_N, d.nullHealthThreshold),
  };
}
