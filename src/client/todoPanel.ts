import type { ClientMessage, TodoAnswerResultMessage, TodoItem } from "../shared/protocol.ts";
import { renderMarkdownInto } from "./viewer.ts";
import {
  CHAT_LINK_MISSING_TEXT,
  TODO_KIND_LABEL,
  ageLabel,
  canSendAnswer,
  chatLinkSeq,
  showsDoneButton,
  todoBreakdown,
  todoButtonText,
  todoMetaText,
} from "./todoModel.ts";

/** 開いている TODO の入力途中の状態（一覧が描き直されても消さない）。 */
interface Draft {
  choice: string | null;
  text: string;
  sending: boolean;
  error: string | null;
  /** 結果が来ないとき（接続切れ等）に「送信中」を解く保険。 */
  timer: ReturnType<typeof setTimeout> | null;
}

/** 結果を待つ上限（ms）。過ぎたら送信中を解いてもう一度押せるようにする。 */
const ANSWER_TIMEOUT_MS = 15000;

/**
 * ボスの TODO パネル（トップバーの「📋 TODO n」から開く）。
 *
 * - 一覧はサーバの WS `todos`（未解決の全件）で描く。追加・解決は master の MCP から来る。
 * - 行を押すと詳細（Markdown）・選択肢（推奨バッジ付き）・補足の入力欄が開く。
 * - 「回答して送る」「✓ 対応した」は WS `todoAnswer`。サーバが master へ流し、受け付けられたら
 *   台帳から消す（`todos` で一覧から消える）。送れなかったら `todoAnswerResult` のエラーを出して残す。
 *
 * XSS 安全: 件名・メタ・選択肢は textContent、詳細は renderMarkdownInto（安全な DOM 構築）で入れる。
 */
export class TodoPanel {
  private items: TodoItem[] = [];
  private openNo: number | null = null;
  private readonly drafts = new Map<number, Draft>();
  private listEl!: HTMLElement;
  private opened = false;
  /** 「チャットで見る」を押したが飛ぶ先が画面に無かった TODO の番号。 */
  private readonly chatMissing = new Set<number>();

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly el: HTMLElement,
    private readonly sendMsg: (msg: ClientMessage) => void,
    /** チャットへ切り替えて seq の発言へ飛ぶ。画面に無ければ false。 */
    private readonly onRevealChat: (seq: number) => boolean,
  ) {
    this.build();
    this.button.addEventListener("click", () => (this.opened ? this.close() : this.open()));
    this.updateButton();
  }

  /** WS `todos`。 */
  update(items: TodoItem[]): void {
    this.items = items;
    const alive = new Set(items.map((it) => it.no));
    for (const [no, d] of [...this.drafts]) {
      if (alive.has(no)) continue;
      if (d.timer) clearTimeout(d.timer);
      this.drafts.delete(no);
    }
    if (this.openNo !== null && !alive.has(this.openNo)) this.openNo = null;
    for (const no of [...this.chatMissing]) if (!alive.has(no)) this.chatMissing.delete(no);
    this.updateButton();
    if (this.opened) this.render();
  }

  /** WS `todoAnswerResult`（送った接続だけに来る）。 */
  handleResult(msg: TodoAnswerResultMessage): void {
    const d = this.drafts.get(msg.no);
    if (!d) return;
    if (d.timer) clearTimeout(d.timer);
    d.timer = null;
    d.sending = false;
    d.error = msg.ok ? null : (msg.error ?? "送れませんでした");
    if (this.opened) this.render();
  }

  open(): void {
    this.opened = true;
    this.el.hidden = false;
    this.button.setAttribute("aria-expanded", "true");
    this.render();
  }

  close(): void {
    this.opened = false;
    this.el.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
  }

  // ===== 内部 =====

  private updateButton(): void {
    this.button.textContent = todoButtonText(this.items.length);
    this.button.title = todoBreakdown(this.items);
    this.button.classList.toggle("has-items", this.items.length > 0);
  }

  private build(): void {
    this.el.replaceChildren();
    this.el.classList.add("todo-panel");
    const backdrop = div("todo-backdrop");
    backdrop.addEventListener("click", () => this.close());
    const sheet = div("todo-sheet");
    const head = div("todo-head");
    const title = div("todo-title");
    title.textContent = "📋 ボスの TODO";
    const closeBtn = document.createElement("button");
    closeBtn.className = "todo-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "閉じる";
    closeBtn.setAttribute("aria-label", "閉じる");
    closeBtn.addEventListener("click", () => this.close());
    head.append(title, closeBtn);
    this.listEl = div("todo-list");
    sheet.append(head, this.listEl);
    this.el.append(backdrop, sheet);
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
  }

  private draftOf(no: number): Draft {
    let d = this.drafts.get(no);
    if (!d) {
      d = { choice: null, text: "", sending: false, error: null, timer: null };
      this.drafts.set(no, d);
    }
    return d;
  }

  private render(): void {
    this.listEl.replaceChildren();
    if (this.items.length === 0) {
      const empty = div("todo-empty");
      empty.textContent = "いまボスがやることはありません。master が TODO を載せるとここに出ます。";
      this.listEl.appendChild(empty);
      return;
    }
    const now = Date.now();
    for (const item of this.items) this.listEl.appendChild(this.renderItem(item, now));
  }

  private renderItem(item: TodoItem, now: number): HTMLElement {
    const isOpen = this.openNo === item.no;
    const row = div(`todo-item kind-${item.kind}${isOpen ? " open" : ""}`);
    const summary = document.createElement("button");
    summary.className = "todo-summary";
    summary.setAttribute("aria-expanded", String(isOpen));
    const kind = TODO_KIND_LABEL[item.kind];
    const no = span("todo-no", `#${item.no}`);
    const icon = span("todo-kind", kind.icon);
    icon.title = kind.name;
    const title = span("todo-item-title", item.title);
    const meta = span("todo-meta", [todoMetaText(item), ageLabel(item.createdAt, now)].filter(Boolean).join(" · "));
    summary.append(no, icon, title, meta);
    summary.addEventListener("click", () => {
      this.openNo = isOpen ? null : item.no;
      this.render();
    });
    // 行の右端に「💬 チャットで見る」（一覧から 1 回で飛べる）。button の中に button は置けないので横に並べる。
    const line = div("todo-line");
    line.appendChild(summary);
    const chatBtn = this.chatLinkButton(item);
    if (chatBtn) line.appendChild(chatBtn);
    row.appendChild(line);
    if (this.chatMissing.has(item.no)) row.appendChild(div("todo-chat-missing", CHAT_LINK_MISSING_TEXT));
    if (isOpen) row.appendChild(this.renderDetail(item));
    return row;
  }

  /** 「💬 チャットで見る」ボタン（チャットとつながっていない TODO では null）。 */
  private chatLinkButton(item: TodoItem): HTMLButtonElement | null {
    const seq = chatLinkSeq(item);
    if (seq === null) return null;
    const b = document.createElement("button");
    b.className = "todo-chat-link";
    b.textContent = "💬 チャットで見る";
    b.title = `この TODO を載せたときのチャットの発言（master#${seq}）へ移ります`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.onRevealChat(seq)) {
        // チャットへ切り替わった。モーダルを閉じて飛んだ先を見せる。
        this.chatMissing.delete(item.no);
        this.close();
        return;
      }
      // 画面に無い（新しい会話にした・400 件より前）。パネルは閉じずに行の下へ理由を出す。
      this.chatMissing.add(item.no);
      this.render();
    });
    return b;
  }

  private renderDetail(item: TodoItem): HTMLElement {
    const d = this.draftOf(item.no);
    const body = div("todo-detail");
    if (item.detail) {
      const md = div("todo-md");
      renderMarkdownInto(md, item.detail);
      body.appendChild(md);
    }

    if (item.options.length > 0) {
      const opts = div("todo-options");
      for (const o of item.options) {
        const b = document.createElement("button");
        b.className = `todo-option${d.choice === o.label ? " selected" : ""}`;
        b.setAttribute("aria-pressed", String(d.choice === o.label));
        b.appendChild(span("todo-option-label", o.label));
        if (item.recommended === o.label) b.appendChild(span("todo-recommended", "推奨"));
        if (o.description) b.appendChild(span("todo-option-desc", o.description));
        b.disabled = d.sending;
        b.addEventListener("click", () => {
          d.choice = d.choice === o.label ? null : o.label;
          d.error = null;
          this.render();
        });
        opts.appendChild(b);
      }
      body.appendChild(opts);
    }

    const text = document.createElement("textarea");
    text.className = "todo-text";
    text.rows = 2;
    text.placeholder = item.options.length > 0 ? "補足（任意）" : "回答・補足";
    text.value = d.text;
    text.disabled = d.sending;
    body.appendChild(text);

    const actions = div("todo-actions");
    const sendBtn = document.createElement("button");
    sendBtn.className = "todo-btn-send";
    sendBtn.textContent = d.sending ? "送信中…" : "回答して送る";
    const syncSend = () => (sendBtn.disabled = d.sending || !canSendAnswer(d.choice, d.text));
    text.addEventListener("input", () => {
      d.text = text.value;
      syncSend();
    });
    syncSend();
    sendBtn.addEventListener("click", () => this.submit(item.no, false));
    actions.appendChild(sendBtn);
    if (showsDoneButton(item)) {
      const doneBtn = document.createElement("button");
      doneBtn.className = "todo-btn-done";
      doneBtn.textContent = "✓ 対応した";
      doneBtn.title = "済ませたことを master に伝えて消します（補足があれば一緒に送ります）";
      doneBtn.disabled = d.sending;
      doneBtn.addEventListener("click", () => this.submit(item.no, true));
      actions.appendChild(doneBtn);
    }
    body.appendChild(actions);

    const hint = div("todo-hint");
    hint.textContent = "送ると master のチャットに「[TODO #" + item.no + "] …」として届き、この TODO は消えます。チャットで答えても構いません。";
    body.appendChild(hint);
    if (d.error) {
      const err = div("todo-error");
      err.textContent = d.error;
      body.appendChild(err);
    }
    return body;
  }

  private submit(no: number, done: boolean): void {
    const d = this.draftOf(no);
    if (d.sending) return;
    if (!done && !canSendAnswer(d.choice, d.text)) return;
    d.sending = true;
    d.error = null;
    d.timer = setTimeout(() => {
      d.timer = null;
      if (!d.sending) return;
      d.sending = false;
      d.error = "サーバから返事がありません（接続を確かめて、もう一度送ってください）";
      if (this.opened) this.render();
    }, ANSWER_TIMEOUT_MS);
    this.sendMsg({
      type: "todoAnswer",
      no,
      ...(d.choice ? { choice: d.choice } : {}),
      ...(d.text.trim() ? { text: d.text } : {}),
      ...(done ? { done: true } : {}),
    });
    this.render();
  }
}

function div(className: string, text?: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}
