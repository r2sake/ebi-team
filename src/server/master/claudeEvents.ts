// claude ヘッドレス（stream-json）の NDJSON を MasterEvent へ正規化する純粋ロジック。
//
// 実測 SoT: docs/poc/master-headless-poc-2026-09-05.md（tmp/poc-m0/run1.excerpt.ndjson の実物）
// I/O もタイマーも持たない。プロセス制御は claudeBrain.ts が担当する。
//
// PoC で判明した「設計書からの修正点」をここに閉じ込める:
//  A) system/init は**最初の user メッセージ送信後**にしか出ず、**毎ターン再送**される。
//     → init 待ちで ready 判定しない（デッドロック）。2 回目以降の同一 init は捨てる。
//  B) 起動直後に SessionStart hook の system/hook_started・hook_response が流れ、本文が巨大。
//     → **未知の system.subtype は捨てる**（UI へ流さない）。
//  C) contextGuard に食わせる文脈占有量は `result.usage` では**なく**、
//     「そのターン最後の assistant イベントの message.usage の
//      input + cache_read + cache_creation」÷「result.modelUsage[model].contextWindow」。
//     result.usage はターン内 API リクエストの合計で**非単調**（ツール往復で水増しされ次ターンで下がる）。
//  F) replay ACK は `type:"user"` で来るが、**tool_result も同じ type** で流れる。
//     → ACK 照合は text ブロック一致で行い、tool_result を弾く。
//  G) 中断後の result は `is_error:true` / `subtype:"error_during_execution"` /
//     `terminal_reason:"aborted_streaming"` で来る。**通常エラー通知に化けさせない**。

import type { MasterEvent, MasterUsage } from "./brain.ts";

/** NDJSON 1 行を JSON へ。壊れた行は null（読み捨てる）。 */
export function parseNdjsonLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/** claude の message.usage（生）。 */
export interface ClaudeRawUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * assistant の message.usage と文脈窓から MasterUsage を作る純関数。
 *
 * contextTokens = input + cache_read + cache_creation（**output は含めない**。
 * 次ターンの入力に載るのは確定した会話履歴であり、その観測値がこの 3 つの和になる）。
 * 3 つとも欠測なら contextTokens は null（0 と区別する）。
 */
export function computeContextUsage(
  usage: ClaudeRawUsage | null | undefined,
  contextWindow: number | null,
): MasterUsage {
  const input = num(usage?.input_tokens);
  const output = num(usage?.output_tokens);
  const cacheRead = num(usage?.cache_read_input_tokens);
  const cacheCreation = num(usage?.cache_creation_input_tokens);
  const parts = [input, cacheRead, cacheCreation].filter((v): v is number => v != null);
  const contextTokens = parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null;
  const contextUsedPct =
    contextTokens != null && contextWindow != null && contextWindow > 0
      ? Math.round((contextTokens / contextWindow) * 1000) / 10
      : null;
  return { input, output, cacheRead, cacheCreation, contextTokens, contextSize: contextWindow, contextUsedPct };
}

/**
 * result イベントから文脈窓を取り出す純関数。
 * `result.modelUsage[model].contextWindow`（PoC 実測で opus-5 は 1,000,000）。
 * model が特定できないときは、載っているモデルのうち最大の窓を使う（1 モデルしか出ない前提の保険）。
 */
export function extractContextWindow(result: unknown, model: string | null): number | null {
  if (!isRecord(result)) return null;
  const mu = result.modelUsage;
  if (!isRecord(mu)) return null;
  if (model && isRecord(mu[model])) {
    const w = num((mu[model] as Record<string, unknown>).contextWindow);
    if (w != null) return w;
  }
  let best: number | null = null;
  for (const entry of Object.values(mu)) {
    if (!isRecord(entry)) continue;
    const w = num(entry.contextWindow);
    if (w != null && (best == null || w > best)) best = w;
  }
  return best;
}

/** content ブロック配列（または素の文字列）から text ブロックだけを連結する。 */
export function textBlocksOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("");
}

/** content ブロック配列に tool_result が含まれるか。 */
export function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((b) => isRecord(b) && b.type === "tool_result");
}

/**
 * 「自分が投げた本文の replay ACK か」を判定する純関数（PoC §5-F）。
 *
 * - `type:"user"` かつ text ブロックの連結が expectedText と一致すること。
 * - **tool_result を含むものは弾く**（ツール往復も同じ type:"user" で流れるため）。
 * - `isReplay` フラグがあればそれも必要条件にする（無い CLI バージョンでも text 一致で通す）。
 */
export function isReplayAckFor(raw: unknown, expectedText: string): boolean {
  if (!isRecord(raw) || raw.type !== "user") return false;
  const message = isRecord(raw.message) ? raw.message : null;
  if (!message) return false;
  if (hasToolResult(message.content)) return false;
  if (raw.isReplay === false) return false;
  return textBlocksOf(message.content) === expectedText;
}

/** ユーザー中断時に claude 自身が挿す内部マーカー（UI へ流さない）。 */
const INTERRUPT_MARKER = "[Request interrupted by user]";

/** AskUserQuestion のツール名（MCP 経由ではないので接尾辞一致で判定する）。 */
const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

export interface NormalizerState {
  sessionId: string | null;
  model: string | null;
  /** そのターンで最後に見た assistant の usage（文脈占有量の唯一の正しい供給源）。 */
  lastAssistantUsage: ClaudeRawUsage | null;
  /** 直近に判明した文脈窓（result から取れる。ターンを跨いで保持）。 */
  contextWindow: number | null;
}

/**
 * NDJSON イベント列を MasterEvent 列へ正規化する状態機械。
 *
 * 状態は「セッション id / モデル / 直近 assistant usage / 文脈窓」だけで、時計も乱数も持たない
 * （＝同じ入力列から必ず同じ出力列が出る）。
 */
export class ClaudeStreamNormalizer {
  private state: NormalizerState = {
    sessionId: null,
    model: null,
    lastAssistantUsage: null,
    contextWindow: null,
  };
  /** interrupt を投げてから result を受けるまで立つフラグ（G の分岐用）。 */
  private interruptPending = false;

  get sessionId(): string | null {
    return this.state.sessionId;
  }
  get model(): string | null {
    return this.state.model;
  }
  /** 直近の文脈使用率（turnEnd を待たずに参照したいとき用）。 */
  get lastUsage(): MasterUsage {
    return computeContextUsage(this.state.lastAssistantUsage, this.state.contextWindow);
  }

  /** interrupt を送った直後に呼ぶ。次の result を「中断」として解釈する。 */
  markInterruptRequested(): void {
    this.interruptPending = true;
  }

  /** NDJSON 1 イベントを正規化する。捨てるイベントでは空配列を返す。 */
  push(raw: unknown): MasterEvent[] {
    if (!isRecord(raw)) return [];
    switch (raw.type) {
      case "system":
        return this.onSystem(raw);
      case "assistant":
        return this.onAssistant(raw);
      case "user":
        return this.onUser(raw);
      case "stream_event":
        return this.onStreamEvent(raw);
      case "result":
        return this.onResult(raw);
      default:
        // control_response / rate_limit_event / 将来の未知 type は捨てる。
        return [];
    }
  }

  private onSystem(raw: Record<string, unknown>): MasterEvent[] {
    // B) 未知の subtype（hook_started / hook_response / thinking_tokens …）は捨てる。
    if (raw.subtype !== "init") return [];
    const sessionId = str(raw.session_id);
    const model = str(raw.model);
    if (model) this.state.model = model;
    // A) init は毎ターン再送される。同じセッションの 2 回目以降は捨てる。
    if (!sessionId || sessionId === this.state.sessionId) return [];
    this.state.sessionId = sessionId;
    const mcpServers = Array.isArray(raw.mcp_servers)
      ? raw.mcp_servers
          .filter(isRecord)
          .map((s) => ({ name: String(s.name ?? ""), status: String(s.status ?? "") }))
      : [];
    const capabilities = Array.isArray(raw.capabilities)
      ? raw.capabilities.filter((c): c is string => typeof c === "string")
      : [];
    return [
      {
        kind: "session",
        sessionId,
        model: this.state.model,
        apiKeySource: str(raw.apiKeySource),
        mcpServers,
        capabilities,
      },
    ];
  }

  private onAssistant(raw: Record<string, unknown>): MasterEvent[] {
    const message = isRecord(raw.message) ? raw.message : null;
    if (!message) return [];
    if (isRecord(message.usage)) {
      // C) 文脈占有量の唯一の正しい供給源。ターンを跨いで保持する（中断ターンで欠測しても
      //    直前の値を落とさない＝単調性が崩れない）。
      this.state.lastAssistantUsage = message.usage as ClaudeRawUsage;
    }
    const out: MasterEvent[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text.length > 0) out.push({ kind: "text", text: block.text, partial: false });
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        out.push({ kind: "thinking", text: block.thinking, partial: false });
      } else if (block.type === "tool_use") {
        out.push(...this.onToolUse(block));
      }
    }
    return out;
  }

  private onToolUse(block: Record<string, unknown>): MasterEvent[] {
    const id = String(block.id ?? "");
    const name = String(block.name ?? "");
    if (name === ASK_USER_QUESTION_TOOL) {
      const questions = isRecord(block.input) && Array.isArray(block.input.questions)
        ? block.input.questions
        : [];
      const out: MasterEvent[] = [];
      questions.forEach((q, i) => {
        if (!isRecord(q)) return;
        const options = Array.isArray(q.options)
          ? q.options.filter(isRecord).map((o) => ({
              label: String(o.label ?? ""),
              ...(typeof o.description === "string" ? { description: o.description } : {}),
            }))
          : [];
        out.push({
          kind: "question",
          id: `${id}#${i}`,
          header: String(q.header ?? ""),
          question: String(q.question ?? ""),
          options,
          multi: q.multiSelect === true,
        });
      });
      // questions が空（形が想定外）なら通常のツール実行として出す（黙って落とさない）。
      if (out.length > 0) return out;
    }
    return [{ kind: "toolCall", id, name, input: block.input ?? null }];
  }

  private onUser(raw: Record<string, unknown>): MasterEvent[] {
    const message = isRecord(raw.message) ? raw.message : null;
    if (!message) return [];
    const content = message.content;
    // F) tool_result は type:"user" で流れる。ACK でも発話でもない。
    if (hasToolResult(content) && Array.isArray(content)) {
      const out: MasterEvent[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== "tool_result") continue;
        out.push({
          kind: "toolResult",
          id: String(block.tool_use_id ?? ""),
          ok: block.is_error !== true,
          content: stringifyToolResult(block.content),
        });
      }
      return out;
    }
    const text = textBlocksOf(content);
    if (text === INTERRUPT_MARKER) return []; // G) 内部マーカーは UI へ流さない
    if (!text) return [];
    // replay（投入 ACK）のみを ack として扱う。isReplay が無い版では text 一致側で照合する。
    if (raw.isReplay === true) return [{ kind: "ack", text }];
    return [];
  }

  private onStreamEvent(raw: Record<string, unknown>): MasterEvent[] {
    const ev = isRecord(raw.event) ? raw.event : null;
    if (!ev || ev.type !== "content_block_delta") return [];
    const delta = isRecord(ev.delta) ? ev.delta : null;
    if (!delta) return [];
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return [{ kind: "text", text: delta.text, partial: true }];
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      return [{ kind: "thinking", text: delta.thinking, partial: true }];
    }
    return [];
  }

  private onResult(raw: Record<string, unknown>): MasterEvent[] {
    const window = extractContextWindow(raw, this.state.model);
    if (window != null) this.state.contextWindow = window;
    const usage = computeContextUsage(this.state.lastAssistantUsage, this.state.contextWindow);
    const isError = raw.is_error === true;
    // G) 中断は「エラー」ではない。terminal_reason か、直前に interrupt を送った事実で判定する。
    const aborted =
      isError && (raw.terminal_reason === "aborted_streaming" || this.interruptPending);
    this.interruptPending = false;
    return [
      {
        kind: "turnEnd",
        ok: !isError,
        aborted,
        usage,
        costUsd: num(raw.total_cost_usd),
        errorText: isError && !aborted ? String(raw.result ?? raw.subtype ?? "unknown error") : null,
      },
    ];
  }
}

/** tool_result の content（文字列 or ブロック配列）を 1 本の文字列にする。 */
function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isRecord(b) && typeof b.text === "string" ? b.text : JSON.stringify(b)))
      .join("");
  }
  return content == null ? "" : JSON.stringify(content);
}
