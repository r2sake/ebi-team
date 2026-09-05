import type {
  MasterChatEnvelope,
  MasterChatState,
  UsageMessage,
} from "../shared/protocol.ts";
import {
  ChatTranscript,
  formatContextPct,
  formatCost,
  headerMetrics,
  NO_RATE_LIMITS,
  oneLine,
  stateLabel,
  stringifyInput,
  summarizeToolInput,
  type ChatItem,
  type HeaderRateLimits,
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
  /** アカウント枠（WS `usage` 由来・ヘッダ表示用）。未受信は「—」。 */
  private rateLimits: HeaderRateLimits = NO_RATE_LIMITS;

  constructor(
    private readonly el: HTMLElement,
    private readonly onSend: (id: string, text: string) => void,
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
    this.sendBtn = document.createElement("button");
    this.sendBtn.className = "chat-send";
    this.sendBtn.addEventListener("click", () => this.onSendClick());
    const row = div("chat-input-row");
    row.append(this.input, this.sendBtn);
    foot.append(this.pendingBar, row);

    const body = div("chat-body");
    body.append(this.logEl, this.newPill);
    this.el.append(this.head, body, foot);
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
    // Enter 送信 / Shift+Enter 改行。IME 変換中（isComposing）の Enter は確定なので送らない。
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    this.onSendClick();
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
    if (!text) return;
    this.onSend(this.masterId, text);
    this.input.value = "";
    this.autoGrow();
    this.scrollToBottom(true);
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

  /**
   * ヘッダのメトリクス（コスト / 文脈% / 5h・週次の枠）を描き直す（PR-M6）。
   * 値は要素ごとに span を分け、65/70/85% を跨いだものだけ色を付ける
   *（contextGuard の通知と同じ帯・chatModel.METRIC_THRESHOLDS）。
   */
  private updateStats(): void {
    this.statsEl.textContent = "";
    const metrics = headerMetrics(this.transcript.summary, this.rateLimits);
    metrics.forEach((m, i) => {
      if (i > 0) this.statsEl.appendChild(span("chat-stat-sep", "/"));
      const el = span(`chat-stat lv-${m.level}`, m.text);
      el.dataset.metric = m.key;
      el.title = m.title;
      this.statsEl.appendChild(el);
    });
  }

  /**
   * WS `usage`（アカウント枠のスナップショット）を取り込む。
   * chat モードの master では `rate_limit_event` → UsageStore 経由で届く（設計書 §5.2 r3）。
   */
  applyUsage(u: UsageMessage): void {
    this.rateLimits = {
      fiveHourPct: u.rateLimits.fiveHour?.usedPct ?? null,
      sevenDayPct: u.rateLimits.sevenDay?.usedPct ?? null,
    };
    this.updateStats();
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
      bubble.append(meta("ボス", item.ts), plain(item.text));
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
