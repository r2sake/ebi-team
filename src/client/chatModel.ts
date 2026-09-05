// master チャット（ui:"chat"）の**表示モデル**。
//
// 設計書: docs/design/master-chat-ui-2026-09-05.md §5.2（PR-M3）
//
// WS の `MasterChatEvent`（時系列のイベント列）を、そのまま画面に並べられる
// 「アイテム列」へ畳み込む純関数群。**DOM にも WebSocket にも依存しない**ので
// node の unit テストからそのまま検証できる（chat.ts が DOM 側を担当する）。
//
// 畳み込みで吸収している仕様:
//  - partial: `text`/`thinking` は `partial:true` のトークン差分が先に流れ、ブロック完了時に
//    `partial:false` の**全文**が来る（claudeEvents.ts）。差分は追記し、全文が来たら置換して閉じる。
//  - tool: `toolCall` と `toolResult` は同じ `id` を持つ 1 つのアイテム（UI では `<details>` 1 個）。
//  - turnEnd: 開いたままの streaming があれば閉じる。usage からコストと文脈% を拾う。

import type { MasterChatEnvelope, MasterChatEvent, MasterChatUsage } from "../shared/protocol.ts";

/** 画面に並べる 1 アイテム。 */
export type ChatItem =
  | { kind: "user"; seq: number; ts: number; text: string }
  | { kind: "assistant"; seq: number; ts: number; text: string; streaming: boolean }
  | { kind: "thinking"; seq: number; ts: number; text: string; streaming: boolean }
  | { kind: "inbound"; seq: number; ts: number; from: string; tag: "reply" | "idle" | "message"; text: string }
  | {
      kind: "tool";
      seq: number;
      ts: number;
      toolId: string;
      name: string;
      input: unknown;
      state: "running" | "ok" | "error";
      result: string | null;
    }
  | {
      kind: "pending";
      seq: number;
      ts: number;
      requestId: string;
      /** 承認 = permission / 質問 = question。 */
      variant: "permission" | "question";
      title: string;
      detail: string;
      options: string[];
    }
  | { kind: "notice"; seq: number; ts: number; level: "info" | "warn" | "error"; text: string }
  | {
      kind: "turnEnd";
      seq: number;
      ts: number;
      ok: boolean;
      aborted: boolean;
      costUsd: number | null;
      totalCostUsd: number | null;
      contextUsedPct: number | null;
      errorText: string | null;
    }
  | { kind: "session"; seq: number; ts: number; model: string | null; sessionId: string };

/** ヘッダに出すサマリ（直近の turnEnd / session 由来）。 */
export interface ChatStats {
  model: string | null;
  /** 会話としての累計コスト(USD)。未受信なら null。 */
  totalCostUsd: number | null;
  /** 文脈使用率(%)。算出できない backend では null（UI は「—」）。 */
  contextUsedPct: number | null;
}

/** apply() の結果。DOM 側は「変わった index だけ」描き直せばよい。 */
export interface ChatChange {
  /** 追加/更新されたアイテムの index（昇順・重複なし）。 */
  touched: number[];
  /** touched のうち「新規追加」の先頭 index（無ければ -1）。 */
  appendedFrom: number;
}

const NO_CHANGE: ChatChange = { touched: [], appendedFrom: -1 };

/**
 * イベント列 → アイテム列の畳み込み器（増分適用）。
 * 1 インスタンス = 1 つの master 会話。`reset()` で snapshot から作り直す。
 */
export class ChatTranscript {
  readonly items: ChatItem[] = [];
  private stats: ChatStats = { model: null, totalCostUsd: null, contextUsedPct: null };
  /** 直近に受けた seq（重複配信を捨てるため）。 */
  private lastSeq = 0;
  /** 追記中の streaming アイテムの index（無ければ -1）。 */
  private openStream = -1;

  /** ヘッダ用サマリの現在値。 */
  get summary(): ChatStats {
    return this.stats;
  }

  get lastAppliedSeq(): number {
    return this.lastSeq;
  }

  /**
   * ヘッダ用サマリだけを初期値へ戻す（「新しい会話」でコスト累計と文脈% が 0 からになるため）。
   * トランスクリプト（items）はそのまま残す。
   */
  resetStats(): void {
    this.stats = { model: this.stats.model, totalCostUsd: null, contextUsedPct: null };
  }

  /** snapshot で総入れ替えする（再接続・初回接続）。 */
  reset(envelopes: readonly MasterChatEnvelope[]): void {
    this.items.length = 0;
    this.stats = { model: null, totalCostUsd: null, contextUsedPct: null };
    this.lastSeq = 0;
    this.openStream = -1;
    for (const env of envelopes) this.apply(env);
  }

  /**
   * イベント 1 件を適用する。
   * 既に適用済みの seq（snapshot と live の重なり）は捨てて no-op を返す。
   */
  apply(env: MasterChatEnvelope): ChatChange {
    if (env.seq <= this.lastSeq) return NO_CHANGE;
    this.lastSeq = env.seq;
    return this.applyEvent(env.seq, env.ts, env.event);
  }

  private applyEvent(seq: number, ts: number, ev: MasterChatEvent): ChatChange {
    switch (ev.kind) {
      case "user":
        this.closeStream();
        return this.push({ kind: "user", seq, ts, text: ev.text });
      case "inbound":
        this.closeStream();
        return this.push({ kind: "inbound", seq, ts, from: ev.from, tag: ev.tag, text: ev.text });
      case "text":
      case "thinking":
        return this.applyStream(seq, ts, ev.kind === "text" ? "assistant" : "thinking", ev.text, ev.partial);
      case "toolCall":
        this.closeStream();
        return this.push({
          kind: "tool",
          seq,
          ts,
          toolId: ev.id,
          name: ev.name,
          input: ev.input,
          state: "running",
          result: null,
        });
      case "toolResult": {
        // 同じ tool_use_id のアイテムへ結果を差し込む（後ろから探す＝同名ツールの再実行に強い）。
        for (let i = this.items.length - 1; i >= 0; i -= 1) {
          const item = this.items[i]!;
          if (item.kind === "tool" && item.toolId === ev.id && item.state === "running") {
            item.state = ev.ok ? "ok" : "error";
            item.result = ev.content;
            return { touched: [i], appendedFrom: -1 };
          }
        }
        // 対応する toolCall を見失った場合も黙って捨てない（単独アイテムとして出す）。
        this.closeStream();
        return this.push({
          kind: "tool",
          seq,
          ts,
          toolId: ev.id,
          name: "(不明なツール)",
          input: null,
          state: ev.ok ? "ok" : "error",
          result: ev.content,
        });
      }
      case "permission":
        this.closeStream();
        return this.push({
          kind: "pending",
          seq,
          ts,
          requestId: ev.id,
          variant: "permission",
          title: `承認が必要: ${ev.toolName}`,
          detail: stringifyInput(ev.input),
          options: ev.suggestions ? [...ev.suggestions] : [],
        });
      case "question":
        this.closeStream();
        return this.push({
          kind: "pending",
          seq,
          ts,
          requestId: ev.id,
          variant: "question",
          title: ev.header || "質問",
          detail: ev.question,
          options: ev.options.map((o) => o.label),
        });
      case "notice":
        this.closeStream();
        return this.push({ kind: "notice", seq, ts, level: ev.level, text: ev.text });
      case "exit":
        this.closeStream();
        return this.push({
          kind: "notice",
          seq,
          ts,
          level: "warn",
          text: `頭脳プロセスが終了しました（code=${ev.code ?? "n/a"} signal=${ev.signal ?? "n/a"}）`,
        });
      case "session":
        this.stats = { ...this.stats, model: ev.model };
        return this.push({ kind: "session", seq, ts, model: ev.model, sessionId: ev.sessionId });
      case "turnEnd": {
        this.closeStream();
        const pct = contextPctOf(ev.usage);
        this.stats = {
          model: this.stats.model,
          totalCostUsd: ev.totalCostUsd ?? this.stats.totalCostUsd,
          contextUsedPct: pct ?? this.stats.contextUsedPct,
        };
        return this.push({
          kind: "turnEnd",
          seq,
          ts,
          ok: ev.ok,
          aborted: ev.aborted,
          costUsd: ev.costUsd,
          totalCostUsd: ev.totalCostUsd,
          contextUsedPct: pct,
          errorText: ev.errorText,
        });
      }
      default:
        return NO_CHANGE;
    }
  }

  /** text/thinking の逐次描画。partial は追記、全文は置換して閉じる。 */
  private applyStream(
    seq: number,
    ts: number,
    kind: "assistant" | "thinking",
    text: string,
    partial: boolean,
  ): ChatChange {
    const index = this.openStream;
    const open = index >= 0 ? this.items[index] : null;
    if (open != null && open.kind === kind) {
      const item = open;
      if (partial) {
        item.text += text;
      } else {
        // ブロック完了。差分の取りこぼし/重複を避けるため全文で置き換える。
        item.text = text;
        item.streaming = false;
        this.openStream = -1;
      }
      return { touched: [index], appendedFrom: -1 };
    }
    // 種別が変わった（text ↔ thinking）ときは開いていたものを閉じてから新規に積む。
    this.closeStream();
    const change = this.push({ kind, seq, ts, text, streaming: partial });
    if (partial) this.openStream = this.items.length - 1;
    return change;
  }

  /** 追記中の streaming を閉じる（turnEnd・別種のイベントが割り込んだとき）。 */
  private closeStream(): void {
    if (this.openStream < 0) return;
    const item = this.items[this.openStream];
    if (item && (item.kind === "assistant" || item.kind === "thinking")) item.streaming = false;
    this.openStream = -1;
  }

  private push(item: ChatItem): ChatChange {
    this.items.push(item);
    const index = this.items.length - 1;
    return { touched: [index], appendedFrom: index };
  }
}

/** usage から文脈使用率(%)を取り出す（算出できない backend は null）。 */
export function contextPctOf(usage: MasterChatUsage | null): number | null {
  if (!usage) return null;
  return usage.contextUsedPct ?? null;
}

/** ツール入力の 1 行要約（`<details>` のサマリ行に出す）。 */
export function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return oneLine(input);
  if (typeof input !== "object") return oneLine(String(input));
  const rec = input as Record<string, unknown>;
  // よく使う代表フィールドを優先して拾う（無ければ JSON の先頭を出す）。
  for (const key of ["command", "file_path", "path", "pattern", "prompt", "text", "message", "to", "id"]) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) return oneLine(v);
  }
  return oneLine(JSON.stringify(input));
}

/** ツール入力の整形（`<details>` を開いたときの本体）。 */
export function stringifyInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** 1 行化 + 長すぎる場合の丸め（サマリ行用）。 */
export function oneLine(src: string, max = 80): string {
  const flat = src.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** コスト表示（未受信は「—」）。 */
export function formatCost(usd: number | null): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  return `$${usd.toFixed(2)}`;
}

/** 文脈使用率の表示（算出できない backend は「—」）。 */
export function formatContextPct(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  return `${Math.round(pct)}%`;
}

/** チャット状態のラベル（ヘッダのバッジ）。 */
export function stateLabel(state: string): string {
  switch (state) {
    case "starting":
      return "起動中…";
    case "idle":
      return "待機中";
    case "busy":
      return "実行中…";
    case "waiting":
      return "応答待ち";
    case "stopped":
      return "停止中";
    default:
      return state;
  }
}
