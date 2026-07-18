import type { ViewerRecord } from "../shared/protocol.ts";
import { parseMarkdown, type MdBlock, type MdInline } from "./markdown.ts";

/**
 * viewer（読み取り専用の md/txt プレビュー）パネル。
 * REGISTRY の viewer 行を選んだときにメイン領域へ描画する DOM。
 * Dashboard と同じく setVisible()/update() インターフェースを持ち、master-detail の 1 枚として出す。
 *
 * XSS 安全: markdown は自前パーサ（markdown.ts）で AST 化し、テキストは **必ず textContent** で
 * 挿入する。innerHTML には生コンテンツを一切入れない（md 中の HTML タグは文字列として表示される）。
 */
export class Viewer {
  private current: ViewerRecord | null = null;

  constructor(
    private readonly el: HTMLElement,
    /** ✗（閉じる）押下時に呼ぶ。closeViewer をサーバへ送る配線に使う。 */
    private readonly onClose: (id: string) => void,
  ) {}

  /** 表示/非表示を切り替える。表示中の viewer を渡すと内容も反映する。 */
  setVisible(visible: boolean, record?: ViewerRecord | null): void {
    this.el.hidden = !visible;
    if (!visible) return;
    if (record !== undefined) this.current = record;
    this.render();
  }

  /** 現在表示中の viewer を差し替えて再描画する（表示中のみ）。 */
  update(record: ViewerRecord | null): void {
    this.current = record;
    if (!this.el.hidden) this.render();
  }

  /** パネル全体を描画する。 */
  private render(): void {
    this.el.innerHTML = "";
    const rec = this.current;
    if (!rec) {
      const empty = document.createElement("p");
      empty.className = "viewer-empty";
      empty.textContent = "viewer が選択されていません。";
      this.el.appendChild(empty);
      return;
    }

    // ヘッダ: タイトル＋パス＋✗。
    const head = document.createElement("div");
    head.className = "viewer-head";

    const titleWrap = document.createElement("div");
    titleWrap.className = "viewer-title-wrap";
    const title = document.createElement("span");
    title.className = "viewer-title";
    title.textContent = `📄 ${rec.title}`;
    const pathEl = document.createElement("span");
    pathEl.className = "viewer-path";
    pathEl.textContent = rec.path;
    pathEl.title = rec.path;
    titleWrap.append(title, pathEl);

    const closeBtn = document.createElement("button");
    closeBtn.className = "viewer-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "この viewer を閉じる";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onClose(rec.id);
    });

    head.append(titleWrap, closeBtn);

    // 本文。
    const body = document.createElement("div");
    body.className = "viewer-body";
    if (rec.format === "txt") {
      // .txt は等幅の生テキスト（textContent で安全に）。
      const pre = document.createElement("pre");
      pre.className = "viewer-txt";
      pre.textContent = rec.content;
      body.appendChild(pre);
    } else {
      body.classList.add("md");
      renderMarkdownInto(body, rec.content);
    }

    this.el.append(head, body);
  }
}

/** markdown 文字列を AST 化し、el 配下へ安全な DOM として構築する。 */
export function renderMarkdownInto(el: HTMLElement, src: string): void {
  for (const block of parseMarkdown(src)) {
    el.appendChild(buildBlock(block));
  }
}

/** ブロック AST → 要素。 */
function buildBlock(block: MdBlock): HTMLElement {
  switch (block.type) {
    case "heading": {
      const level = Math.min(Math.max(block.level, 1), 6);
      const h = document.createElement(`h${level}`);
      appendInline(h, block.children);
      return h;
    }
    case "paragraph": {
      const p = document.createElement("p");
      appendInline(p, block.children);
      return p;
    }
    case "code": {
      const pre = document.createElement("pre");
      pre.className = "md-code";
      const code = document.createElement("code");
      if (block.lang) code.dataset.lang = block.lang;
      code.textContent = block.value; // 生テキスト（textContent で安全）。
      pre.appendChild(code);
      return pre;
    }
    case "list": {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const li = document.createElement("li");
        appendInline(li, item);
        list.appendChild(li);
      }
      return list;
    }
    case "blockquote": {
      const bq = document.createElement("blockquote");
      for (const inner of block.children) bq.appendChild(buildBlock(inner));
      return bq;
    }
    case "hr":
      return document.createElement("hr");
    case "table": {
      const table = document.createElement("table");
      table.className = "md-table";
      const thead = document.createElement("thead");
      const htr = document.createElement("tr");
      for (const cell of block.header) {
        const th = document.createElement("th");
        appendInline(th, cell);
        htr.appendChild(th);
      }
      thead.appendChild(htr);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const row of block.rows) {
        const tr = document.createElement("tr");
        for (const cell of row) {
          const td = document.createElement("td");
          appendInline(td, cell);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      return table;
    }
  }
}

/** インライン AST 配列を親要素へ追加する（テキストは常に textContent 相当で安全）。 */
function appendInline(parent: HTMLElement, nodes: MdInline[]): void {
  for (const node of nodes) {
    parent.appendChild(buildInline(node));
  }
}

/** インライン AST 1 件 → Node。 */
function buildInline(node: MdInline): Node {
  switch (node.type) {
    case "text":
      // 生 HTML タグ等もここに来る。テキストノードなので実行されず文字列表示になる。
      return document.createTextNode(node.value);
    case "code": {
      const code = document.createElement("code");
      code.className = "md-inline-code";
      code.textContent = node.value;
      return code;
    }
    case "strong": {
      const strong = document.createElement("strong");
      appendInline(strong, node.children);
      return strong;
    }
    case "em": {
      const em = document.createElement("em");
      appendInline(em, node.children);
      return em;
    }
    case "link": {
      const a = document.createElement("a");
      // href は属性としてセットするが、テキストは textContent。javascript: 等のスキームは弾く。
      a.href = safeHref(node.href);
      a.textContent = node.text || node.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      // href をツールチップにも出す（クリック遷移前に確認できるように）。
      a.title = node.href;
      return a;
    }
  }
}

/**
 * リンク href の安全化。http/https/mailto/相対・アンカーのみ許可し、
 * javascript: 等の危険スキームは無効化（"#" に置換）する。
 */
function safeHref(href: string): string {
  const trimmed = href.trim();
  if (/^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(trimmed)) return trimmed;
  // スキーム付き（`foo:`）で許可リスト外なら無効化。スキーム無し（相対）は許可。
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return "#";
  return trimmed;
}
