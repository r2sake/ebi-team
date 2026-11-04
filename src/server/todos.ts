// ボスの TODO 台帳（ボスが ebi-team を使う上でやらなければならないこと）。
//
// 設計: docs/plans/boss-todo-plan.md
//
// 方針:
// - 追加・解決は master の MCP（todo_add / todo_resolve）から、回答はボスの UI（WS todoAnswer）から。
//   この台帳自体は呼び出し元を区別しない（master だけに追加させる線引きは MCP ティア側）。
// - 番号 no は通し番号で**使い回さない**。nextNo もファイルに持つので、再起動しても続きから振る。
//   消えた番号を引かれたら「解決済み（no < nextNo）」と「未発行」を返し分ける（履歴は持たない）。
// - 永続化は `.ebi-team/todos.json` へ tmp → rename の atomic 書き出し（viewers.json と同じ流儀）。
//   書き込みは直列化する。storePath が null なら書かない（unit テスト用）。
// - 壊れた todos.json でも起動は止めない（fail-soft）。退避して空の台帳・nextNo=1 で始める。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TodoItem, TodoKind, TodoOption } from "../shared/protocol.ts";

export const TODO_KINDS: readonly TodoKind[] = ["question", "permission", "action"];

/** 入力の上限。 */
export const TODO_LIMITS = {
  title: 120,
  detail: 4000,
  ebi: 80,
  project: 80,
  options: 6,
  optionLabel: 80,
  optionDescription: 300,
} as const;

/** 入力の検証エラー（制御API では 400 に振り分ける）。 */
export class TodoError extends Error {}

/** 永続化ファイルの形。 */
interface TodoFile {
  version: 1;
  nextNo: number;
  items: TodoItem[];
}

/** todo_add に渡せる入力（検証前）。 */
export interface TodoInput {
  title?: unknown;
  detail?: unknown;
  kind?: unknown;
  ebi?: unknown;
  project?: unknown;
  options?: unknown;
  recommended?: unknown;
}

/** 番号を引いた結果。 */
export type TodoLookup =
  | { found: true; item: TodoItem }
  | { found: false; status: "resolved" | "unknown" };

// 改行・タブ以外の制御文字（表示崩れ・端末制御の混入を防ぐ）。
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** 文字列を整える。改行を許さないもの（件名など）は空白に畳む。 */
function cleanText(v: unknown, max: number, multiline: boolean): string {
  if (typeof v !== "string") return "";
  let s = v.replace(CONTROL_RE, "");
  if (!multiline) s = s.replace(/[\r\n\t]+/g, " ");
  s = s.trim();
  return s.length > max ? s.slice(0, max) : s;
}

function cleanOptional(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  const s = cleanText(v, max, false);
  return s === "" ? null : s;
}

/**
 * todo_add の入力を検証して TodoItem の中身（no / createdAt 以外）にする純関数。
 * 不正なら TodoError。長すぎるものは切り詰める（弾かない）。
 */
export function normalizeTodoInput(input: TodoInput): Omit<TodoItem, "no" | "createdAt"> {
  const title = cleanText(input.title, TODO_LIMITS.title, false);
  if (!title) throw new TodoError("title（件名）は必須です");
  const detail = cleanText(input.detail ?? "", TODO_LIMITS.detail, true);
  const kind = input.kind;
  if (typeof kind !== "string" || !(TODO_KINDS as readonly string[]).includes(kind)) {
    throw new TodoError(`kind は ${TODO_KINDS.join(" / ")} のどれかです: ${String(kind)}`);
  }
  const options: TodoOption[] = [];
  if (input.options !== undefined && input.options !== null) {
    if (!Array.isArray(input.options)) throw new TodoError("options は配列で指定してください");
    if (input.options.length > TODO_LIMITS.options) {
      throw new TodoError(`options は ${TODO_LIMITS.options} 個までです`);
    }
    for (const raw of input.options) {
      const o = (typeof raw === "string" ? { label: raw } : raw) as Record<string, unknown> | null;
      if (!o || typeof o !== "object") throw new TodoError("options の要素は {label, description?} です");
      const label = cleanText(o.label, TODO_LIMITS.optionLabel, false);
      if (!label) throw new TodoError("options の label は必須です");
      if (options.some((x) => x.label === label)) throw new TodoError(`options の label が重複しています: ${label}`);
      const description = cleanOptional(o.description, TODO_LIMITS.optionDescription);
      options.push(description ? { label, description } : { label });
    }
  }
  const recommended = cleanOptional(input.recommended, TODO_LIMITS.optionLabel);
  if (recommended && !options.some((o) => o.label === recommended)) {
    throw new TodoError(`recommended は options の label のどれかです: ${recommended}`);
  }
  return {
    title,
    detail,
    kind: kind as TodoKind,
    ebi: cleanOptional(input.ebi, TODO_LIMITS.ebi),
    project: cleanOptional(input.project, TODO_LIMITS.project),
    options,
    recommended,
  };
}

/** 保存ファイルの 1 件を復元する（形が違えば null＝読み捨てる）。 */
function parseStoredItem(raw: unknown): TodoItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.no !== "number" || !Number.isInteger(r.no) || r.no < 1) return null;
  if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return null;
  try {
    return { no: r.no, createdAt: r.createdAt, ...normalizeTodoInput(r as TodoInput) };
  } catch {
    return null;
  }
}

/**
 * 保存ファイルの本文を解釈する純関数。壊れていれば null。
 * nextNo は「保存値」と「残っている最大の no + 1」の大きい方にする（手で消した等の食い違いでも重ならない）。
 */
export function parseTodoFile(text: string): TodoFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as TodoFile).items)) return null;
  const items: TodoItem[] = [];
  for (const it of (raw as TodoFile).items) {
    const item = parseStoredItem(it);
    if (item && !items.some((x) => x.no === item.no)) items.push(item);
  }
  items.sort((a, b) => a.no - b.no);
  const stored = (raw as TodoFile).nextNo;
  const maxNo = items.reduce((m, it) => Math.max(m, it.no), 0);
  const nextNo = Math.max(typeof stored === "number" && Number.isInteger(stored) && stored >= 1 ? stored : 1, maxNo + 1);
  return { version: 1, nextNo, items };
}

export interface TodoBoardOptions {
  /** 保存先（null なら書かない）。 */
  storePath: string | null;
  /** 変化のたびに呼ぶ（WS `todos` の broadcast 用）。 */
  onChange?: (items: TodoItem[]) => void;
  now?: () => number;
}

/** ボスの TODO 台帳。 */
export class TodoBoard {
  private items: TodoItem[] = [];
  private next = 1;
  private writing: Promise<void> = Promise.resolve();
  /** 回答を master へ送っている最中の番号（二重送信の防止）。 */
  private readonly answering = new Set<number>();
  private readonly now: () => number;

  constructor(private readonly opts: TodoBoardOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** 次に振る番号（テスト・表示用）。 */
  get nextNo(): number {
    return this.next;
  }

  /** 起動時に保存ファイルから読み直す。壊れていれば退避して空で始める（throw しない）。 */
  async restore(): Promise<{ restored: number; broken: boolean }> {
    const path = this.opts.storePath;
    if (!path) return { restored: 0, broken: false };
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return { restored: 0, broken: false }; // まだ無い
    }
    const parsed = parseTodoFile(text);
    if (!parsed) {
      const aside = `${path}.broken-${this.now()}`;
      try {
        await rename(path, aside);
        console.warn(`[todos] ${path} が壊れていたので ${aside} へ退避し、空の台帳で始めます`);
      } catch (err) {
        console.warn(`[todos] ${path} が壊れていて退避にも失敗しました: ${(err as Error).message}`);
      }
      return { restored: 0, broken: true };
    }
    this.items = parsed.items;
    this.next = parsed.nextNo;
    return { restored: parsed.items.length, broken: false };
  }

  /** 未解決の全件（番号の昇順＝古い順）。 */
  list(): TodoItem[] {
    return this.items.map((it) => ({ ...it, options: it.options.map((o) => ({ ...o })) }));
  }

  get size(): number {
    return this.items.length;
  }

  /** 番号で引く。無ければ解決済みか未発行かを返す。 */
  lookup(no: number): TodoLookup {
    const item = this.items.find((it) => it.no === no);
    if (item) return { found: true, item: { ...item, options: item.options.map((o) => ({ ...o })) } };
    return { found: false, status: Number.isInteger(no) && no >= 1 && no < this.next ? "resolved" : "unknown" };
  }

  /** 追加する（検証失敗は TodoError）。保存まで待って返す。 */
  async add(input: TodoInput): Promise<TodoItem> {
    const body = normalizeTodoInput(input);
    const item: TodoItem = { no: this.next, createdAt: this.now(), ...body };
    this.next += 1;
    this.items.push(item);
    await this.changed();
    return { ...item, options: item.options.map((o) => ({ ...o })) };
  }

  /** 解決＝台帳から消す。無ければ null。保存まで待って返す。 */
  async resolve(no: number): Promise<TodoItem | null> {
    const idx = this.items.findIndex((it) => it.no === no);
    if (idx < 0) return null;
    const [item] = this.items.splice(idx, 1);
    await this.changed();
    return item!;
  }

  /** 回答の送信を始める。既に送信中なら false。 */
  beginAnswer(no: number): boolean {
    if (this.answering.has(no)) return false;
    this.answering.add(no);
    return true;
  }

  endAnswer(no: number): void {
    this.answering.delete(no);
  }

  private async changed(): Promise<void> {
    this.opts.onChange?.(this.list());
    await this.persist();
  }

  /** atomic 書き出し（直列化）。失敗は warn だけ（台帳の操作は止めない）。 */
  private persist(): Promise<void> {
    const path = this.opts.storePath;
    if (!path) return Promise.resolve();
    const data: TodoFile = { version: 1, nextNo: this.next, items: this.items };
    const text = JSON.stringify(data, null, 2) + "\n";
    this.writing = this.writing.then(async () => {
      const tmp = `${path}.tmp-${process.pid}`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(tmp, text, "utf8");
        await rename(tmp, path);
      } catch (err) {
        console.warn(`[todos] 保存に失敗しました（${path}）: ${(err as Error).message}`);
      }
    });
    return this.writing;
  }
}

/** 回答の中身（UI から）。 */
export interface TodoAnswer {
  choice?: string;
  text?: string;
  done?: boolean;
}

/** 回答の補足に許す長さ。 */
export const TODO_ANSWER_TEXT_MAX = 4000;

/**
 * UI からの回答を master へ流す本文に組む純関数。
 * 例: `[TODO #12 への回答] 件名\n選択: B\n補足: …` / `[TODO #12 対応済み] 件名\n補足: …`
 * 選択も補足も無く done でもなければ null（送るものが無い）。
 */
export function todoAnswerText(item: Pick<TodoItem, "no" | "title">, answer: TodoAnswer): string | null {
  const choice = cleanText(answer.choice, TODO_LIMITS.optionLabel, false);
  const text = cleanText(answer.text, TODO_ANSWER_TEXT_MAX, true);
  if (!answer.done && !choice && !text) return null;
  const head = answer.done ? `[TODO #${item.no} 対応済み] ${item.title}` : `[TODO #${item.no} への回答] ${item.title}`;
  return [head, ...(choice ? [`選択: ${choice}`] : []), ...(text ? [`補足: ${text}`] : [])].join("\n");
}

/**
 * UI からの回答を処理する: 本文を組む → master へ流す → 受け付けられたら台帳から消す。
 * 送れなかったとき（master が止まっている等）は消さずに残す（答えが宙に浮かないように）。
 */
export async function answerTodo(
  board: TodoBoard,
  no: number,
  answer: TodoAnswer,
  deliver: (text: string) => Promise<{ accepted: boolean; reason?: string }>,
): Promise<{ ok: true; item: TodoItem } | { ok: false; error: string }> {
  const found = board.lookup(no);
  if (!found.found) {
    return { ok: false, error: found.status === "resolved" ? `TODO #${no} はもう解決済みです` : `TODO #${no} はありません` };
  }
  if (answer.choice && !found.item.options.some((o) => o.label === answer.choice)) {
    return { ok: false, error: `選択肢にありません: ${answer.choice}` };
  }
  const text = todoAnswerText(found.item, answer);
  if (!text) return { ok: false, error: "選択か補足を入れてください" };
  if (!board.beginAnswer(no)) return { ok: false, error: `TODO #${no} の回答を送っている最中です` };
  try {
    let r: { accepted: boolean; reason?: string };
    try {
      r = await deliver(text);
    } catch (err) {
      r = { accepted: false, reason: (err as Error).message };
    }
    if (!r.accepted) return { ok: false, error: `master へ送れませんでした（TODO は残します）: ${r.reason ?? "不明"}` };
    await board.resolve(no);
    return { ok: true, item: found.item };
  } finally {
    board.endAnswer(no);
  }
}
