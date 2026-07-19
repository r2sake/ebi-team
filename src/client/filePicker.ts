import type { DirListing, DirEntry } from "../shared/protocol.ts";

/**
 * ファイルピッカー（ユーザーが AI を介さず自分で md/txt を開くための簡易ブラウザ）。
 *
 * 設計方針:
 * - サーバの許可ルート（EBI_VIEWER_ROOTS 既定 $HOME/workspace）配下だけをたどれる。
 *   検証は必ずサーバ側（viewerRegistry.listDir / open）で行い、ここは表示と操作のみ。
 * - 一覧・オープンはすべて WebSocket（listDir / openViewer）で行う。HTTP を叩かないので
 *   dev（Vite proxy）でもそのまま動く。
 * - スマホ最優先: 全画面オーバーレイ・大きいタップ領域・16px 入力（iOS 自動ズーム抑止）。
 * - XSS 安全: 一覧のファイル名・パスは必ず textContent で挿入する（innerHTML に生値を入れない）。
 */
export class FilePicker {
  /** モーダルのルート要素（index.html の #file-picker）。 */
  private readonly el: HTMLElement;
  private pathLabel!: HTMLElement;
  private listEl!: HTMLElement;
  private errorEl!: HTMLElement;

  /** いま開いているか。 */
  private opened = false;
  /** 直近に列挙したディレクトリ（「更新」やオープン後の文脈維持用）。 */
  private currentDir = "";
  /** ファイルを開く要求を送って結果（viewers broadcast / notice）待ちか。 */
  private pendingOpen = false;

  constructor(
    el: HTMLElement,
    /** ディレクトリ列挙を要求する（path 省略でルート一覧）。 */
    private readonly onList: (path?: string) => void,
    /** ファイルを開くよう要求する。 */
    private readonly onOpen: (path: string, title?: string) => void,
  ) {
    this.el = el;
    this.build();
  }

  /** モーダル DOM を組み立てる（一度だけ）。 */
  private build(): void {
    this.el.innerHTML = "";
    this.el.classList.add("file-picker");

    // 背景（タップで閉じる）。
    const backdrop = document.createElement("div");
    backdrop.className = "fp-backdrop";
    backdrop.addEventListener("click", () => this.close());

    const panel = document.createElement("div");
    panel.className = "fp-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "ファイルを開く");

    // ヘッダ。
    const head = document.createElement("div");
    head.className = "fp-head";
    const title = document.createElement("span");
    title.className = "fp-title";
    title.textContent = "📂 ファイルを開く";
    const closeBtn = document.createElement("button");
    closeBtn.className = "fp-close";
    closeBtn.type = "button";
    closeBtn.textContent = "✕";
    closeBtn.title = "閉じる";
    closeBtn.setAttribute("aria-label", "閉じる");
    closeBtn.addEventListener("click", () => this.close());
    head.append(title, closeBtn);

    // 現在パス（パンくず的な表示）。
    const pathLabel = document.createElement("div");
    pathLabel.className = "fp-path";
    this.pathLabel = pathLabel;

    // 手入力（絶対パスを直接開くフォールバック）。
    const form = document.createElement("form");
    form.className = "fp-manual";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "fp-manual-input";
    input.placeholder = "パスを直接入力（例: ~/workspace/notes/plan.md）";
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.spellcheck = false;
    input.setAttribute("inputmode", "text");
    const openBtn = document.createElement("button");
    openBtn.type = "submit";
    openBtn.className = "fp-manual-open";
    openBtn.textContent = "開く";
    form.append(input, openBtn);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const p = input.value.trim();
      if (p) this.requestOpen(p);
    });

    // エラー表示行。
    const errorEl = document.createElement("div");
    errorEl.className = "fp-error";
    errorEl.hidden = true;
    this.errorEl = errorEl;

    // 一覧。
    const listEl = document.createElement("div");
    listEl.className = "fp-list";
    this.listEl = listEl;

    panel.append(head, pathLabel, form, errorEl, listEl);
    this.el.append(backdrop, panel);
  }

  /** モーダルを開き、ルート一覧を要求する。 */
  open(): void {
    this.opened = true;
    this.pendingOpen = false;
    this.el.hidden = false;
    this.clearError();
    this.setLoading("読み込み中…");
    // 直近に開いていたディレクトリがあればそこを、無ければルート一覧を要求する。
    this.onList(this.currentDir || undefined);
  }

  /** モーダルを閉じる。 */
  close(): void {
    this.opened = false;
    this.pendingOpen = false;
    this.el.hidden = true;
  }

  /** 開いているか。 */
  isOpen(): boolean {
    return this.opened;
  }

  /** ディレクトリ列挙結果を描画する（サーバの dirListing 応答）。 */
  setListing(listing: DirListing): void {
    if (!this.opened) return;
    this.pendingOpen = false;
    this.clearError();
    this.currentDir = listing.cwd;
    this.pathLabel.textContent = listing.atRoot
      ? `許可ルート（${listing.roots.length}件）`
      : listing.cwd;
    this.pathLabel.title = this.pathLabel.textContent;

    this.listEl.innerHTML = "";

    // 「上へ」行（ルート一覧では出さない）。
    if (listing.up !== null) {
      const up = listing.up;
      const row = this.makeRow("⬆", "上へ", "fp-up");
      row.addEventListener("click", () => {
        this.setLoading("読み込み中…");
        this.onList(up || undefined);
      });
      this.listEl.appendChild(row);
    }

    if (listing.entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "fp-empty";
      empty.textContent = listing.atRoot
        ? "閲覧できる許可ルートがありません（EBI_VIEWER_ROOTS を確認してください）。"
        : "（このディレクトリに表示できる項目はありません）";
      this.listEl.appendChild(empty);
      return;
    }

    for (const entry of listing.entries) {
      this.listEl.appendChild(this.makeEntryRow(entry, listing.atRoot));
    }
  }

  /** 1 エントリ分の行を作る。 */
  private makeEntryRow(entry: DirEntry, atRoot: boolean): HTMLElement {
    if (entry.type === "dir") {
      // ルート一覧ではフルパス、通常はディレクトリ名を表示。
      const label = atRoot ? entry.path : entry.name;
      const row = this.makeRow("📁", label, "fp-dir");
      row.title = entry.path;
      row.addEventListener("click", () => {
        this.setLoading("読み込み中…");
        this.onList(entry.path);
      });
      return row;
    }
    // ファイル。開けるものだけクリック可能、それ以外は淡色で無効化する。
    const openable = entry.eligible === true;
    const row = this.makeRow("📄", entry.name, openable ? "fp-file" : "fp-file fp-disabled");
    row.title = openable ? entry.path : `${entry.path}（.md/.markdown/.txt のみ開けます）`;
    if (openable) {
      row.addEventListener("click", () => this.requestOpen(entry.path, entry.name));
    } else {
      row.setAttribute("aria-disabled", "true");
    }
    return row;
  }

  /** アイコン＋ラベルのタップ行を作る（テキストは textContent で安全に）。 */
  private makeRow(icon: string, label: string, cls: string): HTMLElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `fp-row ${cls}`;
    const ic = document.createElement("span");
    ic.className = "fp-row-icon";
    ic.textContent = icon;
    const tx = document.createElement("span");
    tx.className = "fp-row-label";
    tx.textContent = label;
    row.append(ic, tx);
    return row;
  }

  /** ファイルを開く要求を送り、結果待ち状態にする。 */
  private requestOpen(path: string, title?: string): void {
    this.clearError();
    this.pendingOpen = true;
    this.setStatus("開いています…");
    this.onOpen(path, title);
  }

  /** viewer が実際に開いたときに呼ぶ（成功 → モーダルを閉じる）。 */
  notifyOpened(): void {
    if (this.pendingOpen) {
      this.pendingOpen = false;
      this.close();
    }
  }

  /** オープン失敗の通知（notice id="viewer-open"）を受けたときに呼ぶ。 */
  notifyOpenError(text: string): void {
    if (!this.opened) return;
    this.pendingOpen = false;
    this.setError(text);
  }

  private setLoading(text: string): void {
    this.listEl.innerHTML = "";
    const div = document.createElement("div");
    div.className = "fp-empty";
    div.textContent = text;
    this.listEl.appendChild(div);
  }

  private setStatus(text: string): void {
    this.errorEl.hidden = false;
    this.errorEl.className = "fp-error fp-status";
    this.errorEl.textContent = text;
  }

  setError(text: string): void {
    this.errorEl.hidden = false;
    this.errorEl.className = "fp-error";
    this.errorEl.textContent = text;
  }

  private clearError(): void {
    this.errorEl.hidden = true;
    this.errorEl.textContent = "";
  }
}
