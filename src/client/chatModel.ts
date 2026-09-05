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

import type {
  ChatAttachment,
  ChatImage,
  MasterChatEnvelope,
  MasterChatEvent,
  MasterChatUsage,
} from "../shared/protocol.ts";

/** 画面に並べる 1 アイテム。 */
export type ChatItem =
  | { kind: "user"; seq: number; ts: number; text: string; attachments: ChatAttachment[] }
  | { kind: "assistant"; seq: number; ts: number; text: string; streaming: boolean }
  /** master がチャットへ共有した画像（PR-M10・`chat_image`）。assistant 側に出る。 */
  | { kind: "image"; seq: number; ts: number; images: ChatImage[] }
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
      /** 選択肢の補足（質問のみ。options と同じ並び）。 */
      optionNotes: (string | null)[];
      /** 複数選択できる質問か（承認は常に false）。 */
      multi: boolean;
      /**
       * 決着（PR-M5）。null なら**まだ答えられる**＝ UI はボタンを出す。
       * `permissionSettled` イベントで埋まるので、再接続・サーバ再起動のあとでも
       * snapshot から同じ状態が復元される。
       */
      settled: "allowed" | "denied" | "discarded" | null;
      /** 決着したときに選んだ内容（承認は「許可」/「拒否」）。 */
      answer: string | null;
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
        return this.push({ kind: "user", seq, ts, text: ev.text, attachments: ev.attachments ?? [] });
      case "inbound":
        this.closeStream();
        return this.push({ kind: "inbound", seq, ts, from: ev.from, tag: ev.tag, text: ev.text });
      case "image":
        this.closeStream();
        return this.push({ kind: "image", seq, ts, images: [...ev.images] });
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
          optionNotes: [],
          multi: false,
          settled: null,
          answer: null,
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
          optionNotes: ev.options.map((o) => o.description ?? null),
          multi: ev.multi,
          settled: null,
          answer: null,
        });
      case "permissionSettled": {
        // 対応する pending バブルを畳む（後ろから探す＝同じ id が再利用されても直近が勝つ）。
        for (let i = this.items.length - 1; i >= 0; i -= 1) {
          const item = this.items[i]!;
          if (item.kind !== "pending" || item.requestId !== ev.id || item.settled != null) continue;
          item.settled = ev.outcome;
          item.answer = ev.answer;
          return { touched: [i], appendedFrom: -1 };
        }
        // 対応するバブルを見失った（ring から溢れた等）ときは黙って捨てる。
        return NO_CHANGE;
      }
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

/** 決着した pending バブルの結果ラベル。 */
export function settledLabel(
  outcome: "allowed" | "denied" | "discarded",
  variant: "permission" | "question",
  answer: string | null,
): string {
  switch (outcome) {
    case "allowed":
      return variant === "permission" ? "✅ 許可しました" : `✅ 回答しました: ${answer || "（空）"}`;
    case "denied":
      return "⛔ 拒否しました";
    case "discarded":
      return "🗑 破棄されました（頭脳プロセスが入れ替わったため応答できません）";
  }
}

/** 未応答の pending アイテムの index（スティッキーバーのジャンプ先）。 */
export function firstUnsettledPending(items: readonly ChatItem[]): number {
  return items.findIndex((it) => it.kind === "pending" && it.settled == null);
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

// ===== ライトボックス（PR-M10）=====
//
// 「チャット内の画像をクリックで拡大し、←→ で会話内の全画像を横断する」ための状態機械。
// **DOM 非依存**（chat.ts が値を読んで描画するだけ）にしてあるので、送りの挙動・端での
// 振る舞い・閉じたあとの復帰が unit で検証できる。

/** ライトボックスで送れる画像 1 件（ボス添付と master 共有を同じ形に潰したもの）。 */
export interface LightboxEntry {
  /** 一意キー（`<seq>:<index>`）。クリックされたサムネイルの特定に使う。 */
  key: string;
  /** 配信 URL（`/control/chat-attachment?name=...`）。 */
  url: string;
  /** 保管庫の basename（代替テキスト・欠損時の表示に使う）。 */
  name: string;
  /** 見出し（無ければ null）。 */
  title: string | null;
  /** 説明文（無ければ null）。 */
  caption: string | null;
  /** 共有元 / 保存先の絶対パス（表示用。配信には使わない）。 */
  sourcePath: string | null;
  /** 出どころ（ボスの添付か master の共有か）。 */
  from: "boss" | "master";
  /** 元イベントの seq / ts（時系列の並び順の根拠）。 */
  seq: number;
  ts: number;
}

/**
 * トランスクリプト全体から、時系列順の画像リストを作る。
 *
 * 対象は「ボスが添付した画像（user.attachments の image/*）」と
 * 「master が共有した画像（kind:"image"）」の 2 つで、**同じ 1 列に混ぜる**
 * （設計 §5.2 / 裁定 Q-6(a)。`chat_image` は 1 枚ずつ出すので、吹き出し内に閉じると送りが死ぬ）。
 * items は既に時系列（seq 昇順）で並んでいるので、そのままの順で拾えばよい。
 */
export function collectImages(items: readonly ChatItem[]): LightboxEntry[] {
  const out: LightboxEntry[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      item.attachments.forEach((a, i) => {
        if (!a.mediaType.startsWith("image/")) return; // テキスト添付は拡大対象にしない。
        out.push({
          key: `${item.seq}:${i}`,
          url: a.url,
          name: a.name,
          title: null,
          caption: null,
          sourcePath: a.path,
          from: "boss",
          seq: item.seq,
          ts: item.ts,
        });
      });
    } else if (item.kind === "image") {
      item.images.forEach((img, i) => {
        out.push({
          key: `${item.seq}:${i}`,
          url: img.url,
          name: img.name,
          title: img.title,
          caption: img.caption,
          sourcePath: img.sourcePath,
          from: "master",
          seq: item.seq,
          ts: item.ts,
        });
      });
    }
  }
  return out;
}

/**
 * ライトボックスの状態機械（開いている index と next/prev/close だけ）。
 *
 * - 端では**折り返さない**（最後の画像で `next()` は何もしない）。UI 側は端でボタンを
 *   無効化するので、押しても何も起きないことと表示が一致する。
 * - `setEntries()` は開いたまま新しい画像が届いたときのための更新口。開いている画像が
 *   まだ一覧にあれば**その画像を開いたまま**追従し、消えていれば閉じる。
 */
export class LightboxState {
  private entries: LightboxEntry[] = [];
  private index = -1;

  constructor(entries: readonly LightboxEntry[] = []) {
    this.entries = [...entries];
  }

  /** 一覧を差し替える（開いている画像は key で追従する）。 */
  setEntries(entries: readonly LightboxEntry[]): void {
    const currentKey = this.current?.key ?? null;
    this.entries = [...entries];
    if (currentKey == null) return;
    const next = this.entries.findIndex((e) => e.key === currentKey);
    this.index = next; // 見失ったら -1（＝閉じる）。
  }

  /** key の画像を開く。見つからなければ何もしない（false）。 */
  open(key: string): boolean {
    const i = this.entries.findIndex((e) => e.key === key);
    if (i < 0) return false;
    this.index = i;
    return true;
  }

  /** 閉じる。 */
  close(): void {
    this.index = -1;
  }

  /** 次の画像へ（最後なら何もしない）。移動したら true。 */
  next(): boolean {
    if (this.index < 0 || this.index >= this.entries.length - 1) return false;
    this.index += 1;
    return true;
  }

  /** 前の画像へ（先頭なら何もしない）。移動したら true。 */
  prev(): boolean {
    if (this.index <= 0) return false;
    this.index -= 1;
    return true;
  }

  get isOpen(): boolean {
    return this.index >= 0 && this.index < this.entries.length;
  }

  /** いま開いている画像（閉じていれば null）。 */
  get current(): LightboxEntry | null {
    return this.isOpen ? (this.entries[this.index] ?? null) : null;
  }

  /** 何枚目か（1 始まり・閉じていれば 0）。 */
  get position(): number {
    return this.isOpen ? this.index + 1 : 0;
  }

  /** 全体の枚数。 */
  get count(): number {
    return this.entries.length;
  }

  get hasNext(): boolean {
    return this.isOpen && this.index < this.entries.length - 1;
  }

  get hasPrev(): boolean {
    return this.isOpen && this.index > 0;
  }
}

/** ライトボックスの枚数インジケータ（`3 / 12`）。閉じているときは空文字。 */
export function lightboxCounter(state: LightboxState): string {
  return state.isOpen ? `${state.position} / ${state.count}` : "";
}

// ===== 入力系（PR-M4）=====

/**
 * 貼り付けをファイルへ落とす閾値（文字数）。
 * これを超える貼り付けは入力欄へ展開せず、サーバへ保存してパスを添える誘導に切り替える
 * （設計書 §9 PR-M4「大きな貼り付けはファイルに落として『パスを添えて送る』誘導」）。
 */
export const LARGE_PASTE_CHARS = 8_000;

/** 入力履歴の保持件数（直近 N 件）。 */
export const INPUT_HISTORY_LIMIT = 50;

/** localStorage のキー（v1: 文字列配列の JSON・古い→新しい順）。 */
export const INPUT_HISTORY_KEY = "ebi-team.chat.inputHistory.v1";

/** localStorage の必要な部分だけを写した最小インターフェース（unit から差し替えるため）。 */
export interface HistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * 入力履歴（↑/↓ で過去の送信文を辿る）。
 *
 * DOM に依存しない純クラス。localStorage は `HistoryStorage` として外から渡す
 * （渡さなければメモリのみ＝プライベートモードや localStorage 例外でも壊れない）。
 *
 * 辿り方はシェルと同じ:
 *  - `prev()` で 1 つ古い方へ。最古まで行ったら null（それ以上動かさない）
 *  - `next()` で 1 つ新しい方へ。末端まで戻ると「辿り始めたときの編集中テキスト」を返す
 *  - `push()`（送信時）で履歴に積み、辿り位置をリセットする
 */
export class InputHistory {
  /** 古い → 新しい順。 */
  private entries: string[] = [];
  /** 0 = 最新、1 = その 1 つ前…。-1 は「辿っていない（編集中）」。 */
  private cursor = -1;
  /** 辿り始める直前に入力欄にあったテキスト（末端まで戻ったときに復元する）。 */
  private draft = "";

  constructor(
    private readonly storage: HistoryStorage | null = null,
    private readonly key: string = INPUT_HISTORY_KEY,
    private readonly limit: number = INPUT_HISTORY_LIMIT,
  ) {}

  /** 保存済み履歴を読み込む（壊れた JSON は黙って捨てる）。 */
  load(): void {
    if (!this.storage) return;
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      return; // ストレージ自体が使えない環境（プライベートモード等）
    }
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      this.entries = parsed.filter((v): v is string => typeof v === "string").slice(-this.limit);
    } catch {
      this.entries = [];
    }
  }

  /** 送信した本文を積む（空文字は無視・直前と同じ本文は重複させない）。 */
  push(text: string): void {
    const value = text.trim();
    this.reset();
    if (!value) return;
    if (this.entries[this.entries.length - 1] === value) return;
    // 同じ本文が過去にあれば消してから末尾へ（履歴が同じ文で埋まらないように）。
    const dup = this.entries.indexOf(value);
    if (dup >= 0) this.entries.splice(dup, 1);
    this.entries.push(value);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.persist();
  }

  /** ↑（1 つ古い方へ）。これ以上遡れなければ null。 */
  prev(current: string): string | null {
    if (this.entries.length === 0) return null;
    if (this.cursor < 0) this.draft = current;
    if (this.cursor + 1 >= this.entries.length) return null;
    this.cursor += 1;
    return this.entries[this.entries.length - 1 - this.cursor] ?? null;
  }

  /** ↓（1 つ新しい方へ）。末端では編集中テキストへ戻る。辿っていなければ null。 */
  next(): string | null {
    if (this.cursor < 0) return null;
    this.cursor -= 1;
    if (this.cursor < 0) return this.draft;
    return this.entries[this.entries.length - 1 - this.cursor] ?? null;
  }

  /** 辿り位置を初期化する（送信時・自分で編集し始めたとき）。 */
  reset(): void {
    this.cursor = -1;
    this.draft = "";
  }

  /** いま履歴を辿っている最中か。 */
  get navigating(): boolean {
    return this.cursor >= 0;
  }

  /** 保持件数（テスト・デバッグ用）。 */
  get size(): number {
    return this.entries.length;
  }

  /** 保持している履歴（古い→新しい）のコピー。 */
  list(): string[] {
    return [...this.entries];
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.key, JSON.stringify(this.entries));
    } catch {
      // 容量超過などで書けなくてもチャットは壊さない（メモリ内の履歴は生きている）。
    }
  }
}

/** バイト数の短い表示（添付チップ用）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ===== ヘッダのメトリクス表示（PR-M6）=====
// コスト（プロセス跨ぎ累計）・文脈% ・アカウント枠（5h / 週次）を 1 行に並べる。
// contextGuard（src/server/contextGuard.ts）と同じ 65/70/85% で色分けするため、
// **閾値はサーバ側の DEFAULT_CONTEXT_GUARD_CONFIG と同じ値をここに持つ**
// （client は server を import できないので、値の一致は unit テストで担保する）。

/** メトリクスの警戒度。contextGuard の GuardLevel と同じ帯。 */
export type MetricLevel = "none" | "soft" | "hard" | "critical";

/** 色分けの閾値（%）。contextGuard の soft/hard/critical と同じ。 */
export const METRIC_THRESHOLDS = { soft: 65, hard: 70, critical: 85 } as const;

/** 使用率(%) → 警戒度。null（算出不能）は "none"。 */
export function metricLevel(pct: number | null): MetricLevel {
  if (pct == null || !Number.isFinite(pct)) return "none";
  if (pct >= METRIC_THRESHOLDS.critical) return "critical";
  if (pct >= METRIC_THRESHOLDS.hard) return "hard";
  if (pct >= METRIC_THRESHOLDS.soft) return "soft";
  return "none";
}

/** ヘッダに出すアカウント枠（WS `usage` の rateLimits 由来・使用率だけを取る）。 */
export interface HeaderRateLimits {
  fiveHourPct: number | null;
  sevenDayPct: number | null;
}

export const NO_RATE_LIMITS: HeaderRateLimits = { fiveHourPct: null, sevenDayPct: null };

/** ヘッダの 1 要素（テキスト＋色分け＋ツールチップ）。 */
export interface HeaderMetric {
  key: "cost" | "ctx" | "fiveHour" | "sevenDay";
  text: string;
  level: MetricLevel;
  title: string;
}

/**
 * ヘッダのメトリクス列を作る純関数（DOM 非依存）。
 * 算出できない値は必ず「—」になり、色分けは付かない（codex stub 等の backend）。
 */
export function headerMetrics(stats: ChatStats, rl: HeaderRateLimits): HeaderMetric[] {
  const modelNote = stats.model ? `model: ${stats.model}` : "model: 不明";
  return [
    {
      key: "cost",
      text: formatCost(stats.totalCostUsd),
      level: "none",
      title: `${modelNote} / 会話の累計コスト（推定・プロセスを跨いだ合計）`,
    },
    {
      key: "ctx",
      text: `ctx ${formatContextPct(stats.contextUsedPct)}`,
      level: metricLevel(stats.contextUsedPct),
      title:
        "文脈使用率（context-guard と同じ算出値）。" +
        `${METRIC_THRESHOLDS.soft}% で予告 / ${METRIC_THRESHOLDS.hard}% で /clear 促し / ` +
        `${METRIC_THRESHOLDS.critical}% で危険域`,
    },
    {
      key: "fiveHour",
      text: `5h ${formatContextPct(rl.fiveHourPct)}`,
      level: metricLevel(rl.fiveHourPct),
      title: "アカウント 5 時間枠の使用率（全エビ共通）",
    },
    {
      key: "sevenDay",
      text: `週 ${formatContextPct(rl.sevenDayPct)}`,
      level: metricLevel(rl.sevenDayPct),
      title: "アカウント 7 日枠の使用率（全エビ共通）",
    },
  ];
}

