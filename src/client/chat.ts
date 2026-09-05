import type { ChatAttachment, MasterChatEnvelope, MasterChatState } from "../shared/protocol.ts";
import {
  ChatTranscript,
  formatBytes,
  formatContextPct,
  formatCost,
  InputHistory,
  LARGE_PASTE_CHARS,
  oneLine,
  stateLabel,
  stringifyInput,
  summarizeToolInput,
  type ChatItem,
} from "./chatModel.ts";
import { renderMarkdownInto } from "./viewer.ts";

/**
 * master チャットパネル（ui:"chat" の master をメイン領域に出す 1 枚）。
 *
 * 設計書: docs/design/master-chat-ui-2026-09-05.md §5.1〜§5.3（PR-M3）
 *
 * Dashboard / Viewer と同じ master-detail の 1 枚として振る舞う（setVisible()）。
 * xterm を一切使わないので、ログは**普通の DOM ブロック**（`overflow-y:auto`）。
 * スマホで指スクロールできない現行の問題は、この構造で消える（§5.3）。
 *
 * XSS 安全: assistant 本文は markdown.ts の自前パーサ経由（`textContent` 描画）で、
 * それ以外のテキストもすべて textContent。innerHTML には生コンテンツを入れない。
 *
 * 入力系（PR-M4）: ↑/↓ の入力履歴（localStorage 永続・直近 50 件）、画像のペースト/ドロップ添付
 * （サーバへ保存してから image ブロックとして送る）、大きな貼り付けのファイル誘導。
 *
 * 表示のみで完結しない部分（承認/質問への応答＝chatAnswer）は **PR-M5**。
 * ここでは pending バブルを出すが送信ボタンは無効（灰色 + tooltip）にしてある。
 */
export class ChatPanel {
  private readonly head: HTMLElement;
  private readonly stateBadge: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly newBtn: HTMLButtonElement;
  private readonly logEl: HTMLElement;
  private readonly newPill: HTMLButtonElement;
  private readonly pendingBar: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  /** 添付トレイ（送信前の画像サムネイル）。 */
  private readonly trayEl: HTMLElement;
  /** 大きな貼り付け・添付エラーの一時メッセージ。 */
  private readonly hintEl: HTMLElement;
  /** 送信待ちの添付（送信時にクリアする）。 */
  private readonly attachments: ChatAttachment[] = [];
  /** ↑/↓ の入力履歴（localStorage 永続）。 */
  private readonly history: InputHistory;
  private hintTimer: number | null = null;

  private readonly transcript = new ChatTranscript();
  /** items と 1:1 で並ぶ描画済み要素（増分更新のため index で引く）。 */
  private readonly rendered: HTMLElement[] = [];
  private state: MasterChatState = "stopped";
  private pending = 0;
  private visible = false;
  /** 最下部に張り付いているか（false のとき新着で勝手にスクロールしない）。 */
  private stuckToBottom = true;
  /** 追従を切った後に届いた新着の件数（「⬇ 新着 N 件」ピル用）。 */
  private unseen = 0;
  /** master の agent id（chatState 受信で確定する）。 */
  private masterId: string | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly onSend: (id: string, text: string, attachments: ChatAttachment[]) => void,
    private readonly onStop: (id: string) => void,
    private readonly onNew: (id: string) => void,
  ) {
    this.el.classList.add("chat");

    // ---- ヘッダ（状態 / コスト・文脈 / 新しい会話）----
    this.head = div("chat-head");
    const title = span("chat-title", "💬 master");
    this.stateBadge = span("chat-state", stateLabel(this.state));
    this.statsEl = span("chat-stats", "");
    this.newBtn = document.createElement("button");
    this.newBtn.className = "chat-new";
    this.newBtn.textContent = "🆕 新しい会話";
    this.newBtn.title =
      "頭脳プロセスを resume 無しで起動し直し、文脈をリセットします（これまでの表示は残ります）";
    this.newBtn.addEventListener("click", () => {
      if (!this.masterId) return;
      if (!window.confirm("新しい会話を始めます（いまの文脈はリセットされます）。よろしいですか？")) return;
      // 会話が切り替わるとコスト累計も文脈も 0 からなので、次の turnEnd まで「—」に戻す。
      this.transcript.resetStats();
      this.updateStats();
      this.onNew(this.masterId);
    });
    this.head.append(title, this.stateBadge, this.statsEl, this.newBtn);

    // ---- ログ ----
    this.logEl = div("chat-log");
    this.logEl.addEventListener("scroll", () => this.onScroll());

    // 追従を切っている間の新着通知ピル。押すと最下部へ戻る。
    this.newPill = document.createElement("button");
    this.newPill.className = "chat-newpill";
    this.newPill.hidden = true;
    this.newPill.addEventListener("click", () => this.scrollToBottom(true));

    // ---- 入力欄 ----
    const foot = div("chat-foot");
    this.pendingBar = div("chat-pending-bar");
    this.pendingBar.hidden = true;
    this.input = document.createElement("textarea");
    this.input.className = "chat-input";
    this.input.rows = 1;
    this.input.placeholder = "master に話しかける（Enter で送信 / Shift+Enter で改行）";
    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.input.addEventListener("input", () => this.autoGrow());
    this.input.addEventListener("paste", (e) => this.onPaste(e));
    // ドロップは入力欄だけでなくパネル全体で受ける（ログ側に落としても添付できる）。
    this.el.addEventListener("dragover", (e) => {
      if (!this.hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      this.el.classList.add("dragover");
    });
    this.el.addEventListener("dragleave", () => this.el.classList.remove("dragover"));
    this.el.addEventListener("drop", (e) => this.onDrop(e));
    this.sendBtn = document.createElement("button");
    this.sendBtn.className = "chat-send";
    this.sendBtn.addEventListener("click", () => this.onSendClick());
    const row = div("chat-input-row");
    row.append(this.input, this.sendBtn);
    this.trayEl = div("chat-tray");
    this.trayEl.hidden = true;
    this.hintEl = div("chat-hint");
    this.hintEl.hidden = true;
    foot.append(this.pendingBar, this.hintEl, this.trayEl, row);

    const body = div("chat-body");
    body.append(this.logEl, this.newPill);
    this.el.append(this.head, body, foot);
    this.history = new InputHistory(safeLocalStorage());
    this.history.load();
    this.syncControls();
  }

  /** chat モードの master が居るか（居なければ main.ts は従来の PTY ペインを出す）。 */
  get chatMasterId(): string | null {
    return this.masterId;
  }

  /** 表示/非表示（master-detail の 1 枚として）。 */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.el.hidden = !visible;
    // 表示に切り替えた瞬間は最下部へ寄せる（隠れている間の新着を見せる）。
    if (visible) this.scrollToBottom(true);
  }

  /** WS `chatState`。chat モードの master が居ることの判定材料も兼ねる。 */
  applyState(id: string, state: MasterChatState, pending: number): void {
    this.masterId = id;
    this.state = state;
    this.pending = pending;
    this.stateBadge.textContent = stateLabel(state);
    this.stateBadge.className = `chat-state state-${state}`;
    this.syncControls();
  }

  /** WS `chatSnapshot`（接続直後・再接続時の一括復元）。 */
  applySnapshot(envelopes: readonly MasterChatEnvelope[], hasMore: boolean): void {
    this.transcript.reset(envelopes);
    this.renderAll(hasMore);
    this.scrollToBottom(true);
  }

  /** WS `chatEvent`（live 1 件）。 */
  applyEvent(envelope: MasterChatEnvelope): void {
    const change = this.transcript.apply(envelope);
    if (change.touched.length === 0) return;
    const wasBottom = this.stuckToBottom;
    for (const index of change.touched) this.renderItem(index);
    this.updateStats();
    if (wasBottom) {
      this.scrollToBottom(false);
    } else if (change.appendedFrom >= 0) {
      this.unseen += 1;
      this.updatePill();
    }
  }

  /** 接続が切れたときの表示（再接続で snapshot が来れば戻る）。 */
  markDisconnected(): void {
    this.stateBadge.textContent = "切断（再接続中…）";
    this.stateBadge.className = "chat-state state-stopped";
  }

  /** 入力欄へフォーカス（広幅のみ。狭幅は勝手にソフトキーボードを出さない）。 */
  focusInput(): void {
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    this.input.focus();
  }

  // ===== 内部 =====

  private onKeyDown(e: KeyboardEvent): void {
    if (e.isComposing) return; // IME 変換中のキーはすべて変換操作（履歴も送信も動かさない）。
    // ↑/↓ の入力履歴。複数行を編集しているときの行移動を邪魔しないよう、
    // ↑ は「キャレットが先頭」、↓ は「キャレットが末尾」のときだけ履歴として振る舞う。
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.metaKey) {
      const atStart = this.input.selectionStart === 0 && this.input.selectionEnd === 0;
      const atEnd =
        this.input.selectionStart === this.input.value.length &&
        this.input.selectionEnd === this.input.value.length;
      if (e.key === "ArrowUp" && (atStart || this.history.navigating)) {
        const text = this.history.prev(this.input.value);
        if (text !== null) {
          e.preventDefault();
          this.setInputValue(text);
        }
        return;
      }
      if (e.key === "ArrowDown" && (atEnd || this.history.navigating)) {
        const text = this.history.next();
        if (text !== null) {
          e.preventDefault();
          this.setInputValue(text);
        }
        return;
      }
      return;
    }
    // Enter 送信 / Shift+Enter 改行。
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    this.onSendClick();
  }

  /** 履歴から取り出した本文を入力欄へ入れ、キャレットを末尾に置く。 */
  private setInputValue(text: string): void {
    this.input.value = text;
    this.autoGrow();
    const end = text.length;
    this.input.setSelectionRange(end, end);
  }

  private onSendClick(): void {
    if (!this.masterId) return;
    // 実行中は ⏹（中断）として振る舞う。
    if (this.state === "busy") {
      this.onStop(this.masterId);
      return;
    }
    if (this.state === "starting" || this.state === "stopped") return;
    const text = this.input.value.trim();
    // 添付だけで送るケース（画像を貼って Enter）も許す。
    if (!text && this.attachments.length === 0) return;
    this.onSend(this.masterId, text, [...this.attachments]);
    this.history.push(text);
    this.attachments.length = 0;
    this.renderTray();
    this.input.value = "";
    this.autoGrow();
    this.scrollToBottom(true);
  }

  // ---- 添付（ペースト / ドロップ）----

  /** DataTransfer にファイルが含まれるか（ドラッグ中はまだ items しか見えない）。 */
  private hasFiles(dt: DataTransfer | null): boolean {
    if (!dt) return false;
    if (dt.files?.length) return true;
    return Array.from(dt.items ?? []).some((i) => i.kind === "file");
  }

  /**
   * 貼り付け。
   *  - 画像が含まれていれば添付として取り込む（既定のテキスト貼り付けは行わない）
   *  - テキストが LARGE_PASTE_CHARS を超えていたらファイルに落とし、**パスを入力欄へ添える**
   *    （長文をそのまま送ると 1 ターンの入力が跳ね上がるため。設計書 §9 PR-M4）
   */
  private onPaste(e: ClipboardEvent): void {
    const dt = e.clipboardData;
    if (!dt) return;
    const images = Array.from(dt.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (images.length > 0) {
      e.preventDefault();
      void this.attachFiles(images);
      return;
    }
    const text = dt.getData("text/plain");
    if (text.length > LARGE_PASTE_CHARS) {
      e.preventDefault();
      void this.spillLargePaste(text);
    }
  }

  private onDrop(e: DragEvent): void {
    this.el.classList.remove("dragover");
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    void this.attachFiles(files);
  }

  /** 画像をサーバへ保存し、添付トレイへ積む。 */
  private async attachFiles(files: readonly File[]): Promise<void> {
    for (const file of files) {
      try {
        const saved = await uploadAttachment(file, file.type);
        this.attachments.push(saved);
        this.renderTray();
      } catch (err) {
        this.showHint(`添付に失敗しました: ${(err as Error).message}`, "error");
      }
    }
  }

  /**
   * 大きな貼り付けをファイルへ落として、入力欄にはパスだけを残す。
   * 保存に失敗したときは**そのまま貼り付ける**（入力を失わせない）。
   */
  private async spillLargePaste(text: string): Promise<void> {
    try {
      const saved = await uploadAttachment(new Blob([text], { type: "text/plain" }), "text/plain");
      const note = `${saved.path}`;
      const cur = this.input.value;
      const sep = cur.length > 0 && !cur.endsWith("\n") ? "\n" : "";
      this.setInputValue(`${cur}${sep}${note}\n`);
      this.showHint(
        `貼り付けが長い（${text.length.toLocaleString("ja-JP")} 文字）ためファイルに保存しました。` +
          `パスを入力欄に添えたので、そのまま送ると master がファイルとして読みます（${formatBytes(saved.bytes)}）`,
        "info",
      );
    } catch (err) {
      this.setInputValue(this.input.value + text);
      this.showHint(`長文の保存に失敗したのでそのまま貼り付けました: ${(err as Error).message}`, "error");
    }
  }

  /** 添付トレイ（送信前のサムネイル）を描き直す。 */
  private renderTray(): void {
    this.trayEl.innerHTML = "";
    this.trayEl.hidden = this.attachments.length === 0;
    for (const [i, a] of this.attachments.entries()) {
      const chip = div("chat-chip");
      const img = document.createElement("img");
      img.className = "chat-chip-thumb";
      img.src = a.url;
      img.alt = a.name;
      const label = span("chat-chip-name", `${a.name}（${formatBytes(a.bytes)}）`);
      label.title = a.path;
      const del = document.createElement("button");
      del.className = "chat-chip-del";
      del.textContent = "✕";
      del.title = "この添付を外す";
      del.addEventListener("click", () => {
        this.attachments.splice(i, 1);
        this.renderTray();
      });
      chip.append(img, label, del);
      this.trayEl.appendChild(chip);
    }
  }

  /** 入力欄の上に一時メッセージを出す（大きな貼り付けの誘導・添付エラー）。 */
  private showHint(text: string, level: "info" | "error"): void {
    this.hintEl.textContent = text;
    this.hintEl.className = `chat-hint level-${level}`;
    this.hintEl.hidden = false;
    if (this.hintTimer !== null) window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => {
      this.hintEl.hidden = true;
      this.hintTimer = null;
    }, 15_000);
  }

  /** 入力欄の高さを内容に合わせる（最大 6 行程度）。 */
  private autoGrow(): void {
    // 空のときは CSS 既定（1 行）へ戻す。明示 height を残すと空欄が伸びたままになる。
    if (this.input.value.length === 0) {
      this.input.style.height = "";
      return;
    }
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 160)}px`;
  }

  /** 状態に応じて送信ボタン・入力欄・pending バーを更新する。 */
  private syncControls(): void {
    const busy = this.state === "busy";
    this.sendBtn.textContent = busy ? "⏹ 停止" : "送信";
    this.sendBtn.classList.toggle("stop", busy);
    const blocked = this.state === "starting" || this.state === "stopped";
    this.sendBtn.disabled = blocked;
    this.input.disabled = blocked;
    this.input.placeholder = blocked
      ? "master（chat）が起動していません…"
      : "master に話しかける（Enter で送信 / Shift+Enter で改行）";
    this.newBtn.disabled = this.state === "starting";
    if (this.pending > 0) {
      this.pendingBar.hidden = false;
      this.pendingBar.textContent = `⏸ 未応答の承認/質問が ${this.pending} 件あります（応答は PR-M5 で対応）`;
    } else {
      this.pendingBar.hidden = true;
    }
  }

  private onScroll(): void {
    // 「最下部にいる」判定は 32px の遊びを持たせる（§5.3）。
    const atBottom =
      this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - 32;
    this.stuckToBottom = atBottom;
    if (atBottom) {
      this.unseen = 0;
      this.updatePill();
    }
  }

  private scrollToBottom(force: boolean): void {
    if (!this.visible && !force) return;
    this.logEl.scrollTop = this.logEl.scrollHeight;
    this.stuckToBottom = true;
    this.unseen = 0;
    this.updatePill();
  }

  private updatePill(): void {
    this.newPill.hidden = this.unseen === 0;
    this.newPill.textContent = `⬇ 新着 ${this.unseen} 件`;
  }

  private updateStats(): void {
    const s = this.transcript.summary;
    this.statsEl.textContent = `${formatCost(s.totalCostUsd)} / ctx ${formatContextPct(s.contextUsedPct)}`;
    this.statsEl.title = s.model
      ? `model: ${s.model} / 累計コスト（推定）と文脈使用率`
      : "累計コスト（推定）と文脈使用率";
  }

  /** snapshot 適用時の全描画。 */
  private renderAll(hasMore: boolean): void {
    this.logEl.innerHTML = "";
    this.rendered.length = 0;
    if (hasMore) {
      // JSONL のページングは PR-M4 以降。ここでは「もっと前がある」ことだけ示す。
      const more = div("chat-more");
      more.textContent = "（これより前の会話はログファイルにのみ残っています）";
      this.logEl.appendChild(more);
    }
    for (let i = 0; i < this.transcript.items.length; i += 1) this.renderItem(i);
    this.updateStats();
  }

  /** items[index] を描画（新規は append、既存は差し替え）。 */
  private renderItem(index: number): void {
    const item = this.transcript.items[index];
    if (!item) return;
    const next = buildItem(item);
    const prev = this.rendered[index];
    if (prev) {
      // ツールの `<details>` は開閉状態をユーザーが持っているので引き継ぐ。
      const prevDetails = prev.querySelector("details");
      const nextDetails = next.querySelector("details");
      if (prevDetails && nextDetails && prevDetails.open) nextDetails.open = true;
      prev.replaceWith(next);
    } else {
      this.logEl.appendChild(next);
    }
    this.rendered[index] = next;
  }
}

// ===== アイテム 1 件 → DOM =====

/** 1 アイテムを表す要素を作る（テキストはすべて textContent 経由＝XSS 安全）。 */
function buildItem(item: ChatItem): HTMLElement {
  switch (item.kind) {
    case "user": {
      const row = bubbleRow("user");
      const bubble = div("chat-bubble user");
      bubble.append(meta("ボス", item.ts));
      if (item.text) bubble.appendChild(plain(item.text));
      if (item.attachments.length > 0) bubble.appendChild(attachmentStrip(item.attachments));
      row.appendChild(bubble);
      return row;
    }
    case "assistant": {
      const row = bubbleRow("assistant");
      const bubble = div("chat-bubble assistant" + (item.streaming ? " streaming" : ""));
      const body = div("chat-md");
      renderMarkdownInto(body, item.text);
      bubble.append(meta("master", item.ts), body);
      if (item.streaming) bubble.appendChild(span("chat-caret", "▍"));
      row.appendChild(bubble);
      return row;
    }
    case "thinking": {
      const row = bubbleRow("assistant");
      const det = document.createElement("details");
      det.className = "chat-thinking";
      const sum = document.createElement("summary");
      sum.textContent = `💭 思考${item.streaming ? "中…" : ""}`;
      const body = div("chat-thinking-body");
      body.textContent = item.text;
      det.append(sum, body);
      row.appendChild(det);
      return row;
    }
    case "inbound": {
      const row = bubbleRow("inbound");
      const bubble = div(`chat-bubble inbound tag-${item.tag}`);
      const label =
        item.tag === "reply" ? "🦐 返信" : item.tag === "idle" ? "🦐 待機通知" : "🦐 メッセージ";
      bubble.append(meta(`${label}（${item.from}）`, item.ts));
      if (item.tag === "idle" && item.text.trim().length === 0) {
        bubble.appendChild(span("chat-idle-note", "本文なし（作業完了の合図）"));
      } else {
        const body = div("chat-md");
        renderMarkdownInto(body, item.text);
        bubble.appendChild(body);
      }
      row.appendChild(bubble);
      return row;
    }
    case "tool": {
      const row = bubbleRow("tool");
      const det = document.createElement("details");
      det.className = `chat-tool state-${item.state}`;
      const sum = document.createElement("summary");
      const icon = item.state === "running" ? "⏳" : item.state === "ok" ? "✅" : "❌";
      sum.textContent = `🔧 ${item.name} ${icon} ${summarizeToolInput(item.input)}`.trimEnd();
      det.appendChild(sum);
      const inputText = stringifyInput(item.input);
      if (inputText) {
        const pre = document.createElement("pre");
        pre.className = "chat-tool-input";
        pre.textContent = inputText;
        det.appendChild(pre);
      }
      if (item.result != null) {
        const pre = document.createElement("pre");
        pre.className = "chat-tool-result";
        pre.textContent = clip(item.result);
        det.appendChild(pre);
      }
      row.appendChild(det);
      return row;
    }
    case "pending": {
      const row = bubbleRow("assistant");
      const bubble = div("chat-bubble pending");
      bubble.append(meta(item.variant === "permission" ? "⏸ 承認待ち" : "❓ 質問", item.ts));
      const t = div("chat-pending-title");
      t.textContent = item.title;
      const d = div("chat-pending-detail");
      d.textContent = oneLine(item.detail, 400);
      bubble.append(t, d);
      const actions = div("chat-pending-actions");
      const labels = item.options.length > 0 ? item.options : ["許可", "拒否"];
      for (const label of labels) {
        const b = document.createElement("button");
        b.className = "chat-pending-btn";
        b.textContent = label;
        b.disabled = true;
        b.title = "PR-M5 で対応（この PR では応答を送信しません）";
        actions.appendChild(b);
      }
      bubble.appendChild(actions);
      row.appendChild(bubble);
      return row;
    }
    case "notice": {
      const el = div(`chat-system level-${item.level}`);
      el.textContent = item.text;
      return el;
    }
    case "session": {
      const el = div("chat-system level-info");
      el.textContent = `🧠 セッション開始（model: ${item.model ?? "?"}）`;
      el.title = `sessionId: ${item.sessionId}`;
      return el;
    }
    case "turnEnd": {
      const el = div("chat-turnend");
      if (item.aborted) {
        el.classList.add("aborted");
        el.textContent = "⏹ 中断しました";
      } else if (!item.ok) {
        el.classList.add("error");
        el.textContent = `⚠ エラー: ${item.errorText ?? "詳細不明"}`;
      } else {
        el.textContent = `${formatCost(item.totalCostUsd)} / ctx ${formatContextPct(item.contextUsedPct)}`;
        el.title = "会話の累計コスト（推定）と文脈使用率";
      }
      return el;
    }
  }
}

/** 長すぎるツール結果を丸める（全文は PR-M4 で「全部見る」を付ける）。 */
function clip(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}\n…（${text.length - max} 文字省略）` : text;
}

function bubbleRow(variant: string): HTMLElement {
  return div(`chat-row ${variant}`);
}

function meta(label: string, ts: number): HTMLElement {
  const el = div("chat-meta");
  el.textContent = `${label} · ${new Date(ts).toLocaleTimeString("ja-JP")}`;
  return el;
}

function plain(text: string): HTMLElement {
  const el = div("chat-plain");
  el.textContent = text;
  return el;
}

function div(cls: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = cls;
  return el;
}

function span(cls: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = cls;
  el.textContent = text;
  return el;
}

/** 送信済みメッセージに付いた添付のサムネイル列。 */
function attachmentStrip(attachments: readonly ChatAttachment[]): HTMLElement {
  const strip = div("chat-attachments");
  for (const a of attachments) {
    const cell = div("chat-attachment");
    if (a.mediaType.startsWith("image/")) {
      const img = document.createElement("img");
      img.className = "chat-attachment-thumb";
      img.src = a.url;
      img.alt = a.name;
      img.title = a.path;
      cell.appendChild(img);
    }
    const name = span("chat-attachment-name", a.name);
    name.title = a.path;
    cell.appendChild(name);
    strip.appendChild(cell);
  }
  return strip;
}

/**
 * チャット添付を保存する（`POST /control/chat-attach`）。
 * Content-Type が MIME、ボディが生バイト列。保存先はサーバが決める（クライアントは
 * パスを指定できない）ので、返ってきた絶対パスをそのまま master への提示に使う。
 */
async function uploadAttachment(
  body: Blob,
  mediaType: string,
): Promise<ChatAttachment> {
  const res = await fetch("/control/chat-attach", {
    method: "POST",
    headers: { "Content-Type": mediaType },
    body,
    credentials: "same-origin",
  });
  const json = (await res.json().catch(() => null)) as (ChatAttachment & { error?: string }) | null;
  if (!res.ok || !json || typeof json.name !== "string") {
    throw new Error(json?.error ?? `HTTP ${res.status}`);
  }
  return json;
}

/** localStorage（使えない環境では null）。プライベートモードで例外を投げる実装がある。 */
function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}
