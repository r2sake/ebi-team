import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AgentRecord, AgentStatus } from "../shared/protocol.ts";

/**
 * 1つの agent に対応する xterm.js ペイン。
 * キー入力は onInput、リサイズは onResize でサーバへ中継する。
 */
export class Pane {
  readonly id: string;
  readonly el: HTMLDivElement;
  private readonly term: Terminal;
  private readonly fit: FitAddon;
  private readonly dot: HTMLSpanElement;
  /** 監督・要約ボタン（既定 OFF のときは生成しない）。 */
  private readonly summarizeBtn: HTMLButtonElement | null;
  private ro: ResizeObserver | null = null;

  constructor(
    record: AgentRecord,
    private readonly onInput: (id: string, data: string) => void,
    private readonly onResize: (id: string, cols: number, rows: number) => void,
    private readonly onKill: (id: string) => void,
    private readonly onFocus: (id: string) => void,
    // 監督・要約のコールバック。supervisorEnabled=false のときは未指定（ボタンを出さない）。
    private readonly onSummarize?: (id: string) => void,
  ) {
    this.id = record.id;

    this.el = document.createElement("div");
    this.el.className = "pane";
    this.el.dataset.id = record.id;

    const head = document.createElement("div");
    head.className = "pane-head";

    const idWrap = document.createElement("span");
    idWrap.className = "id";
    this.dot = document.createElement("span");
    this.dot.className = `dot ${record.status}`;
    idWrap.append(this.dot, document.createTextNode(record.id));

    // ヘッダ右側のボタン群。
    const actions = document.createElement("div");
    actions.className = "pane-actions";

    // 監督・要約ボタンは supervisor 有効時のみ生成する（OFF 時は DOM に出さない）。
    if (this.onSummarize) {
      const btn = document.createElement("button");
      btn.className = "summarize";
      btn.textContent = "🔍 要約";
      btn.title = "サブスク(claude CLI / Haiku)でこのエビの直近の状況を要約（オンデマンド）";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onSummarize?.(this.id);
      });
      this.summarizeBtn = btn;
      actions.appendChild(btn);
    } else {
      this.summarizeBtn = null;
    }

    // 種別バッジ（master/supervisor/dynamic）。master/supervisor は色で区別する。
    const badge = document.createElement("span");
    badge.className = `kind-badge kind-${record.kind}`;
    badge.textContent =
      record.kind === "master" ? "👑 master" : record.kind === "supervisor" ? "🛡 supervisor" : "dynamic";
    if (record.model) badge.title = `model: ${record.model}`;
    idWrap.append(document.createTextNode(" "), badge);

    // 固定エビ（pinned）は kill ボタンを出さない（削除不可）。動的エビのみ kill 可。
    if (!record.pinned) {
      const killBtn = document.createElement("button");
      killBtn.className = "kill";
      killBtn.textContent = "✕";
      killBtn.title = "この agent を kill";
      killBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onKill(this.id);
      });
      actions.appendChild(killBtn);
    }

    head.append(idWrap, actions);

    const termHost = document.createElement("div");
    termHost.className = "pane-term";

    this.el.append(head, termHost);
    this.el.addEventListener("mousedown", () => this.onFocus(this.id));

    this.term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { background: "#000000" },
      scrollback: 5000,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(termHost);

    // ペインへの生キー入力をサーバへ。
    this.term.onData((data) => this.onInput(this.id, data));

    // 要素サイズ変化に追従して fit + PTY resize 連動。
    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(termHost);

    // 初回 fit（次フレームで実寸が出てから）。
    requestAnimationFrame(() => this.refit());
  }

  /** fit してサーバへ resize を通知する。 */
  refit(): void {
    try {
      this.fit.fit();
      const { cols, rows } = this.term;
      if (cols > 0 && rows > 0) this.onResize(this.id, cols, rows);
    } catch {
      // レイアウト未確定時は無視。
    }
  }

  write(data: string): void {
    // 非表示中でも出力は受け取り続ける（バックスクロールに溜める）。
    this.term.write(data);
  }

  /**
   * 再アタッチ用スクロールバックを書き戻して画面を復元する。
   * 既存内容を reset でクリアしてから write することで、
   * WS 切断→再接続で同じペインに scrollback が再送されても二重表示にならない。
   * リロード直後（新規 xterm）は空からの復元になる。
   */
  restoreScrollback(data: string): void {
    this.term.reset();
    this.term.write(data);
  }

  /**
   * メイン領域での表示/非表示を切り替える。
   * PTY も xterm も破棄せず、DOM 上の display だけを切り替える。
   * 表示にした瞬間はレイアウト確定後に fit して PTY へ resize を送る。
   */
  setVisible(visible: boolean): void {
    this.el.classList.toggle("hidden", !visible);
    if (visible) {
      // レイアウト確定を待ってから fit（隠れている間はサイズ 0 になりがち）。
      requestAnimationFrame(() => {
        this.refit();
        this.term.focus();
      });
    }
  }

  setStatus(status: AgentStatus): void {
    this.dot.className = `dot ${status}`;
  }

  /** 要約ボタンのローディング表示を切り替える（要約中は無効化）。 */
  setSummarizing(loading: boolean): void {
    if (!this.summarizeBtn) return;
    this.summarizeBtn.disabled = loading;
    this.summarizeBtn.textContent = loading ? "… 要約中" : "🔍 要約";
  }

  dispose(): void {
    this.ro?.disconnect();
    this.ro = null;
    this.term.dispose();
    this.el.remove();
  }
}
