import type {
  ClientMessage,
  FileEditLoadedMessage,
  FileEditSavedMessage,
  FileEditView,
} from "../shared/protocol.ts";
import { applyEnvValues, envKeysPresent, maskLine } from "../shared/envEdit.ts";
import { compactDiff, diffLines, diffStats } from "../shared/lineDiff.ts";

/** master の request_file_edit から開くときの依頼内容（値は含まない）。 */
export interface FileEditRequestInfo {
  requestId: string;
  path: string;
  keys: string[];
  note: string | null;
  from: string;
}

/**
 * ファイル編集ダイアログ（ボスが UI からファイル＝主に env を書き換える）。
 *
 * 流れ: パス入力 →（サーバが検証して本文を返す）→ 編集 → 差分の確認 → 保存。
 * master の依頼（request_file_edit）から開いたときはパス固定で、鍵ごとの入力欄を出す。
 *
 * 秘密の値の扱い:
 * - 本文は WS の `fileEditOpen` / `fileEditSave` で**この接続とサーバの間だけ**を流れる
 *   （チャットのトランスクリプト・notice・master には載らない）。
 * - 秘密っぽいファイル（サーバ判定）は既定で伏せ字。差分も伏せ字で出せる。
 * - 保存後・閉じたときは本文と入力欄を消す（保存後に内容を再表示しない）。
 *
 * XSS 安全: 値・パス・差分はすべて textContent / value で入れる（innerHTML に生値を入れない）。
 */
export class FileEditorDialog {
  private readonly el: HTMLElement;
  private titleEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private statusEl!: HTMLElement;

  /** 応答の突き合わせに使う「いま待っているパス」。null なら待っていない。 */
  private waitingFor: { op: "open" | "save"; path: string } | null = null;
  /** 開いているファイル（本文を含む。閉じる・保存したら null に戻して手放す）。 */
  private file: FileEditView | null = null;
  private request: FileEditRequestInfo | null = null;
  /** 伏せ字で表示するか。 */
  private masked = false;
  /** 全文編集の textarea（鍵入力モードでは null）。 */
  private textarea: HTMLTextAreaElement | null = null;
  /** 鍵入力モードの入力欄（鍵名 → input）。 */
  private keyInputs = new Map<string, HTMLInputElement>();
  /** 全文編集中か（依頼の鍵入力モードから切り替えられる）。 */
  private fullText = true;
  /** 「控えを残す」「フォルダを作る」の選択。 */
  private backup = true;
  private createDirs = false;
  /** 差分確認へ進んだときの保存予定の本文。 */
  private nextContent: string | null = null;
  private opened = false;

  constructor(el: HTMLElement, private readonly sendMsg: (msg: ClientMessage) => void) {
    this.el = el;
    this.build();
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** パス入力から始める（ボスが自分で開く）。 */
  open(initialPath = ""): void {
    this.reset();
    this.request = null;
    this.show();
    this.renderPathStep(initialPath);
  }

  /** master の依頼から開く（パス固定・鍵入力モード）。 */
  openRequest(req: FileEditRequestInfo): void {
    this.reset();
    this.request = req;
    this.show();
    this.load(req.path);
  }

  /** 閉じる（本文と入力値を手放す）。 */
  close(): void {
    this.reset();
    this.opened = false;
    this.el.hidden = true;
  }

  /** WS `fileEditLoaded`。 */
  handleLoaded(msg: FileEditLoadedMessage): void {
    if (!this.waitingFor || this.waitingFor.op !== "open" || this.waitingFor.path !== msg.path) return;
    this.waitingFor = null;
    if (msg.error || !msg.file) {
      this.setStatus(msg.error ?? "開けませんでした", "error");
      if (!this.request) this.renderPathStep(msg.path);
      else this.renderRequestError();
      return;
    }
    this.file = msg.file;
    this.masked = msg.file.secret;
    this.backup = msg.file.exists;
    this.createDirs = false;
    this.fullText = !(this.request && this.request.keys.length > 0);
    this.renderEditStep();
  }

  /** WS `fileEditSaved`。 */
  handleSaved(msg: FileEditSavedMessage): void {
    if (!this.waitingFor || this.waitingFor.op !== "save" || this.waitingFor.path !== msg.path) return;
    this.waitingFor = null;
    if (msg.error || !msg.saved) {
      this.setStatus(msg.error ?? "保存できませんでした", "error");
      if (msg.conflict) this.renderConflict();
      else this.renderConfirmStep();
      return;
    }
    // 保存できた。本文は二度と出さない（手放してから完了表示だけを描く）。
    const saved = msg.saved;
    this.wipe();
    this.titleEl.textContent = "✅ 保存しました";
    this.bodyEl.replaceChildren();
    const lines = [
      `${saved.action === "create" ? "新規作成" : "上書き"}: ${saved.path}`,
      `${saved.bytes} バイト`,
      ...(saved.createdDirs.length > 0 ? [`作成したフォルダ: ${saved.createdDirs.join(", ")}`] : []),
      ...(saved.backupPath ? [`控え: ${saved.backupPath}`] : []),
      ...(this.request ? ["master には「保存した」ことだけを伝えます（値は伝えません）。"] : []),
    ];
    for (const t of lines) this.bodyEl.appendChild(textRow("fe-done-line", t));
    this.setStatus("", "info");
    this.setActions([button("閉じる", "fe-btn primary", () => this.close())]);
  }

  // ===== 画面 =====

  private build(): void {
    this.el.replaceChildren();
    this.el.classList.add("file-picker", "file-editor");
    const backdrop = div("fp-backdrop");
    // 入力中の内容を誤タップで失わないよう、背景タップでは閉じない（✕ / キャンセルで閉じる）。
    const panel = div("fp-panel fe-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "ファイルを編集");
    const head = div("fp-head");
    this.titleEl = span("fp-title", "📝 ファイルを編集");
    const closeBtn = button("✕", "fp-close", () => this.close());
    closeBtn.title = "閉じる（入力中の内容は破棄されます）";
    closeBtn.setAttribute("aria-label", "閉じる");
    head.append(this.titleEl, closeBtn);
    this.bodyEl = div("fe-body");
    this.statusEl = div("fp-error");
    this.statusEl.hidden = true;
    const actions = div("fe-actions");
    panel.append(head, this.statusEl, this.bodyEl, actions);
    this.el.append(backdrop, panel);
    this.el.hidden = true;
  }

  private get actionsEl(): HTMLElement {
    return this.el.querySelector(".fe-actions") as HTMLElement;
  }

  private setActions(buttons: HTMLElement[]): void {
    this.actionsEl.replaceChildren(...buttons);
  }

  private setStatus(text: string, level: "error" | "info"): void {
    this.statusEl.textContent = text;
    this.statusEl.hidden = text === "";
    this.statusEl.classList.toggle("fp-status", level === "info");
  }

  private show(): void {
    this.opened = true;
    this.el.hidden = false;
  }

  /** 状態を初期化する（本文・入力値も手放す）。 */
  private reset(): void {
    this.wipe();
    this.waitingFor = null;
    this.setStatus("", "info");
    this.titleEl.textContent = "📝 ファイルを編集";
  }

  /** 本文と入力値をメモリと DOM から消す。 */
  private wipe(): void {
    if (this.textarea) this.textarea.value = "";
    for (const input of this.keyInputs.values()) input.value = "";
    this.textarea = null;
    this.keyInputs = new Map();
    this.file = null;
    this.nextContent = null;
    this.bodyEl.replaceChildren();
    this.actionsEl.replaceChildren();
  }

  private load(path: string): void {
    this.waitingFor = { op: "open", path };
    this.setStatus("読み込み中…", "info");
    this.sendMsg({ type: "fileEditOpen", path, ...(this.request ? { requestId: this.request.requestId } : {}) });
  }

  /** 1) パス入力。 */
  private renderPathStep(initial: string): void {
    this.titleEl.textContent = "📝 ファイルを編集";
    this.bodyEl.replaceChildren();
    const form = document.createElement("form");
    form.className = "fp-manual fe-path-form";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "fp-manual-input";
    input.placeholder = "フルパス（例: ~/.config/webgame-guide/prd.env）";
    input.value = initial;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "off");
    const go = button("開く", "fp-manual-open", () => {});
    go.type = "submit";
    form.append(input, go);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const path = input.value.trim();
      if (!path) return;
      this.load(path);
    });
    this.bodyEl.append(
      form,
      textRow(
        "fe-hint",
        "許可ルート（サーバの EBI_EDIT_ROOTS・既定は ~/workspace と ~/.config）の配下だけを編集できます。無いファイルは新規作成になります。",
      ),
    );
    this.setActions([button("キャンセル", "fe-btn", () => this.close())]);
    queueMicrotask(() => input.focus());
  }

  /** 依頼のファイルが開けなかったとき（見送るか閉じるだけ）。 */
  private renderRequestError(): void {
    this.bodyEl.replaceChildren();
    if (this.request) this.bodyEl.appendChild(textRow("fe-path", this.request.path));
    this.setActions([
      this.cancelRequestButton(),
      button("閉じる", "fe-btn", () => this.close()),
    ]);
  }

  /** 2) 編集。 */
  private renderEditStep(): void {
    const file = this.file;
    if (!file) return;
    this.setStatus("", "info");
    this.titleEl.textContent = file.exists ? "📝 ファイルを編集" : "📝 ファイルを新規作成";
    // 再描画（伏せ字の切替・モード切替）で入力途中の値を失わないよう、いまの値を拾っておく。
    const draftText = this.textarea?.value ?? null;
    const draftKeys = new Map([...this.keyInputs].map(([k, el]) => [k, el.value]));
    this.bodyEl.replaceChildren();
    this.textarea = null;
    this.keyInputs = new Map();

    const info = div("fe-info");
    info.appendChild(textRow("fe-path", file.path));
    const badges = div("fe-badges");
    badges.appendChild(span(`fe-badge ${file.exists ? "" : "new"}`, file.exists ? `既存 ${file.size} バイト` : "新規作成"));
    if (file.secret) badges.appendChild(span("fe-badge secret", "🔒 秘密を含むファイル"));
    info.appendChild(badges);
    if (this.request) {
      info.appendChild(textRow("fe-request", `${this.request.from} からの依頼`));
      if (this.request.note) info.appendChild(textRow("fe-note", this.request.note));
    }
    this.bodyEl.appendChild(info);

    // 表示オプション。
    const opts = div("fe-opts");
    opts.appendChild(
      checkbox("伏せ字で表示", this.masked, (v) => {
        this.masked = v;
        this.renderEditStep();
      }),
    );
    if (this.request && this.request.keys.length > 0) {
      opts.appendChild(
        checkbox("全文を編集する", this.fullText, (v) => {
          this.fullText = v;
          this.renderEditStep();
        }),
      );
    }
    this.bodyEl.appendChild(opts);

    if (this.fullText) {
      const ta = document.createElement("textarea");
      ta.className = `fe-text${this.masked ? " masked" : ""}`;
      ta.spellcheck = false;
      ta.autocomplete = "off";
      ta.setAttribute("autocapitalize", "off");
      ta.rows = 14;
      ta.value = draftText ?? file.content ?? "";
      this.textarea = ta;
      this.bodyEl.appendChild(ta);
      if (this.masked) {
        this.bodyEl.appendChild(
          textRow("fe-hint", "伏せ字のまま編集できます（内容を確かめたいときは「伏せ字で表示」を外す）。"),
        );
      }
    } else if (this.request) {
      const present = envKeysPresent(file.content ?? "");
      const list = div("fe-keys");
      for (const key of this.request.keys) {
        const row = div("fe-key-row");
        const label = document.createElement("label");
        label.className = "fe-key-label";
        label.textContent = key;
        const state = span(
          `fe-key-state ${present.has(key) ? "set" : "unset"}`,
          present.has(key) ? "設定済み（変える時だけ入力）" : "未設定",
        );
        const input = document.createElement("input");
        input.type = this.masked ? "password" : "text";
        input.className = "fe-key-input";
        input.autocomplete = "new-password";
        input.spellcheck = false;
        input.setAttribute("autocapitalize", "off");
        input.placeholder = present.has(key) ? "変更しない" : "値を入力";
        input.value = draftKeys.get(key) ?? "";
        const id = `fe-key-${key}`;
        input.id = id;
        label.htmlFor = id;
        this.keyInputs.set(key, input);
        row.append(label, state, input);
        list.appendChild(row);
      }
      this.bodyEl.appendChild(list);
    }

    if (file.missingDirs.length > 0) {
      const dirs = div("fe-dirs");
      dirs.appendChild(textRow("fe-warn", "親フォルダがありません。保存すると次のフォルダを作ります:"));
      for (const d of file.missingDirs) dirs.appendChild(textRow("fe-path", d));
      dirs.appendChild(
        checkbox("フォルダを作成してよい", this.createDirs, (v) => {
          this.createDirs = v;
        }),
      );
      this.bodyEl.appendChild(dirs);
    }
    if (file.exists) {
      this.bodyEl.appendChild(
        checkbox("上書き前に控えを残す（同じフォルダに <名前>.bak-日時）", this.backup, (v) => {
          this.backup = v;
        }),
      );
    }

    this.setActions([
      ...(this.request ? [this.cancelRequestButton()] : []),
      button("キャンセル", "fe-btn", () => this.close()),
      button("差分を確認 →", "fe-btn primary", () => this.toConfirm()),
    ]);
  }

  /** 編集内容から保存予定の本文を作って差分確認へ進む。 */
  private toConfirm(): void {
    const file = this.file;
    if (!file) return;
    let next: string;
    if (this.textarea) {
      next = this.textarea.value;
    } else {
      const values: Record<string, string> = {};
      for (const [key, input] of this.keyInputs) {
        if (input.value !== "") values[key] = input.value;
      }
      if (Object.keys(values).length === 0) {
        this.setStatus("値を 1 つ以上入力してください", "error");
        return;
      }
      try {
        next = applyEnvValues(file.content ?? "", values);
      } catch (err) {
        this.setStatus((err as Error).message, "error");
        return;
      }
    }
    if (file.missingDirs.length > 0 && !this.createDirs) {
      this.setStatus("「フォルダを作成してよい」にチェックを入れてください", "error");
      return;
    }
    this.nextContent = next;
    this.renderConfirmStep();
  }

  /** 3) 差分の確認。 */
  private renderConfirmStep(): void {
    const file = this.file;
    const next = this.nextContent;
    if (!file || next == null) return;
    this.titleEl.textContent = file.exists ? "🔍 上書きの確認" : "🔍 新規作成の確認";
    // 編集欄は DOM から外すだけで手放さない（「戻る」で入力途中から続けられるように）。
    // 本文と入力値は閉じる・保存したときに wipe() で消す。
    if (this.textarea) this.textarea.hidden = true;
    const keepTextarea = this.textarea;
    this.bodyEl.replaceChildren();
    if (keepTextarea) this.bodyEl.appendChild(keepTextarea); // 「戻る」で編集を続けられるよう保持
    this.bodyEl.appendChild(textRow("fe-path", file.path));

    const all = diffLines(file.content ?? "", next);
    const stats = diffStats(all);
    if (file.exists && stats.added === 0 && stats.removed === 0) {
      this.bodyEl.appendChild(textRow("fe-hint", "変更がありません。"));
      this.setActions([button("← 戻る", "fe-btn", () => this.backToEdit())]);
      return;
    }
    this.bodyEl.appendChild(
      textRow("fe-hint", `+${stats.added} 行 / -${stats.removed} 行${this.masked ? "（値は伏せ字）" : ""}`),
    );
    const pre = document.createElement("pre");
    pre.className = "fe-diff";
    for (const line of compactDiff(all, 2)) {
      const text = line.op === "…" ? line.text : this.masked ? maskLine(line.text) : line.text;
      const row = document.createElement("div");
      row.className = `fe-diff-line op-${line.op === "+" ? "add" : line.op === "-" ? "del" : line.op === "…" ? "skip" : "ctx"}`;
      row.textContent = `${line.op === "…" ? " " : line.op} ${text}`;
      pre.appendChild(row);
    }
    this.bodyEl.appendChild(pre);
    if (file.missingDirs.length > 0) {
      this.bodyEl.appendChild(textRow("fe-warn", `フォルダを作成します: ${file.missingDirs.join(", ")}`));
    }
    if (file.exists) {
      this.bodyEl.appendChild(textRow("fe-hint", this.backup ? "控えを残してから上書きします。" : "控えは残しません。"));
    }
    this.setActions([
      button("← 戻る", "fe-btn", () => this.backToEdit()),
      button(file.exists ? "上書き保存する" : "作成する", "fe-btn primary", () => this.save()),
    ]);
  }

  private backToEdit(): void {
    this.nextContent = null;
    this.renderEditStep();
  }

  private save(): void {
    const file = this.file;
    const next = this.nextContent;
    if (!file || next == null) return;
    for (const b of this.actionsEl.querySelectorAll("button")) (b as HTMLButtonElement).disabled = true;
    this.waitingFor = { op: "save", path: file.path };
    this.setStatus("保存中…", "info");
    this.sendMsg({
      type: "fileEditSave",
      path: file.path,
      content: next,
      baseHash: file.baseHash,
      createDirs: this.createDirs,
      backup: file.exists && this.backup,
      ...(this.request ? { requestId: this.request.requestId } : {}),
    });
  }

  /** 開いた後に他所で書き換わっていたとき（開き直すしかない）。 */
  private renderConflict(): void {
    const path = this.file?.path ?? this.request?.path ?? "";
    this.wipe();
    this.bodyEl.appendChild(textRow("fe-hint", "入力した内容は保存していません。開き直してから、もう一度編集してください。"));
    this.setActions([
      button("閉じる", "fe-btn", () => this.close()),
      button("開き直す", "fe-btn primary", () => this.load(path)),
    ]);
  }

  private cancelRequestButton(): HTMLButtonElement {
    return button("見送る", "fe-btn danger", () => {
      const req = this.request;
      if (!req) return;
      if (!window.confirm("この依頼を見送ります（master には「見送った」と伝わります）。よろしいですか？")) return;
      this.sendMsg({ type: "fileEditCancel", requestId: req.requestId });
      this.close();
    });
  }
}

// ===== DOM ヘルパ（すべて textContent 経由）=====

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

function textRow(cls: string, text: string): HTMLDivElement {
  const el = div(cls);
  el.textContent = text;
  return el;
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.className = "fe-check";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.addEventListener("change", () => onChange(box.checked));
  wrap.append(box, document.createTextNode(` ${label}`));
  return wrap;
}
