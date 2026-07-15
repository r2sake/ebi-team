import type { UsageMessage, UsageRateLimits } from "../shared/protocol.ts";

/**
 * 使用状況ダッシュボード。
 * REGISTRY 最上段「📊 ダッシュボード」を選んだときにメイン領域へ描画する DOM。
 * - アカウント枠: 5h / 7d のレート制限（使用率バー＋解除カウントダウン）。
 * - エビ別テーブル: id / model / context% / 推定コスト$ / token 内訳。
 * - 合計推定コスト。
 * データは WS `usage` で受信し、最新スナップショットを保持して再描画する。
 * cost は「推定」（Max サブスクの実請求とは別）である旨を注記する。
 */
export class Dashboard {
  /** 最新の usage スナップショット。未受信なら null。 */
  private latest: UsageMessage | null = null;
  /** 表示中か（非表示中はカウントダウン更新を止める）。 */
  private visible = false;
  /** 解除カウントダウンの再描画タイマ（1 秒間隔）。 */
  private countdownTimer: number | null = null;

  constructor(private readonly el: HTMLElement) {}

  /** 表示/非表示を切り替える。表示中だけ 1 秒ごとにカウントダウンを更新する。 */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.el.hidden = !visible;
    if (visible) {
      this.render();
      if (this.countdownTimer === null) {
        this.countdownTimer = window.setInterval(() => this.render(), 1000);
      }
    } else if (this.countdownTimer !== null) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  /** WS `usage` を受信したら最新値を保持し、表示中なら再描画する。 */
  update(msg: UsageMessage): void {
    this.latest = msg;
    if (this.visible) this.render();
  }

  /** ダッシュボード全体を描画する。 */
  private render(): void {
    const u = this.latest;
    this.el.innerHTML = "";

    const title = document.createElement("h2");
    title.className = "dash-title";
    title.textContent = "📊 使用状況ダッシュボード";
    this.el.appendChild(title);

    if (!u || (u.agents.length === 0 && !u.rateLimits.fiveHour && !u.rateLimits.sevenDay)) {
      const empty = document.createElement("p");
      empty.className = "dash-empty";
      empty.textContent =
        "データ待ち（各エビの statusLine が更新されると反映されます）。idle のエビは値が古くなることがあります。";
      this.el.appendChild(empty);
      return;
    }

    this.el.appendChild(this.renderRateLimits(u.rateLimits));
    this.el.appendChild(this.renderAgentsTable(u));

    const note = document.createElement("p");
    note.className = "dash-note";
    note.textContent =
      "コストは推定額（Max サブスクは実質サブスク内・実請求とは別）。値は各エビの statusLine 更新時に反映され、idle のエビは古くなることがあります。";
    this.el.appendChild(note);
  }

  /** アカウント枠（5h / 7d のレート制限）。 */
  private renderRateLimits(rl: UsageRateLimits): HTMLElement {
    const box = document.createElement("div");
    box.className = "dash-ratelimits";

    const head = document.createElement("h3");
    head.className = "dash-subtitle";
    head.textContent = "アカウント レート制限（全エビ共通）";
    box.appendChild(head);

    box.appendChild(this.renderRateRow("5 時間枠", rl.fiveHour));
    box.appendChild(this.renderRateRow("7 日枠", rl.sevenDay));
    return box;
  }

  /** レート制限 1 行（使用率バー＋％＋解除カウントダウン）。 */
  private renderRateRow(
    label: string,
    data: { usedPct: number; resetsAt: number } | null,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "dash-rate-row";

    const name = document.createElement("span");
    name.className = "dash-rate-label";
    name.textContent = label;
    row.appendChild(name);

    if (!data) {
      const na = document.createElement("span");
      na.className = "dash-rate-na";
      na.textContent = "データ待ち";
      row.appendChild(na);
      return row;
    }

    const barWrap = document.createElement("div");
    barWrap.className = "dash-bar-wrap";
    const bar = document.createElement("div");
    bar.className = "dash-bar";
    const pct = Math.max(0, Math.min(100, data.usedPct));
    bar.style.width = `${pct}%`;
    if (pct >= 90) bar.classList.add("danger");
    else if (pct >= 70) bar.classList.add("warn");
    barWrap.appendChild(bar);
    row.appendChild(barWrap);

    const pctText = document.createElement("span");
    pctText.className = "dash-rate-pct";
    pctText.textContent = `${data.usedPct}%`;
    row.appendChild(pctText);

    const reset = document.createElement("span");
    reset.className = "dash-rate-reset";
    reset.textContent = `解除まで ${formatCountdown(data.resetsAt)}`;
    row.appendChild(reset);

    return row;
  }

  /** エビ別テーブル。 */
  private renderAgentsTable(u: UsageMessage): HTMLElement {
    const box = document.createElement("div");
    box.className = "dash-agents";

    const head = document.createElement("h3");
    head.className = "dash-subtitle";
    head.textContent = "エビ別 使用状況";
    box.appendChild(head);

    const table = document.createElement("table");
    table.className = "dash-table";
    const thead = document.createElement("thead");
    thead.innerHTML =
      "<tr><th>id</th><th>model</th><th>context</th><th>推定$</th>" +
      "<th>input</th><th>output</th><th>cacheRead</th><th>cacheCreate</th></tr>";
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    if (u.agents.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 8;
      td.className = "dash-waiting";
      td.textContent = "データ待ち";
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      for (const a of u.agents) {
        const tr = document.createElement("tr");
        tr.appendChild(td(a.id));
        tr.appendChild(td(a.model ?? "-"));
        tr.appendChild(td(a.contextUsedPct === null ? "-" : `${a.contextUsedPct}%`));
        tr.appendChild(td(a.costUsd === null ? "-" : `$${a.costUsd.toFixed(2)}`));
        tr.appendChild(td(numOrDash(a.tokens.input)));
        tr.appendChild(td(numOrDash(a.tokens.output)));
        tr.appendChild(td(numOrDash(a.tokens.cacheRead)));
        tr.appendChild(td(numOrDash(a.tokens.cacheCreation)));
        tbody.appendChild(tr);
      }
    }
    table.appendChild(tbody);
    box.appendChild(table);

    const total = document.createElement("p");
    total.className = "dash-total";
    total.textContent = `合計推定コスト: $${u.totalCostUsd.toFixed(2)}（推定）`;
    box.appendChild(total);

    return box;
  }
}

/** セル生成ヘルパー。 */
function td(text: string): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.textContent = text;
  cell.title = text;
  return cell;
}

/** 数値を桁区切りで返す。null は "-"。 */
function numOrDash(n: number | null): string {
  return n === null ? "-" : n.toLocaleString("en-US");
}

/**
 * resets_at（Unix epoch 秒）から「あと X時間Y分Z秒」を作る。
 * すでに過ぎていれば「まもなく解除」。
 */
function formatCountdown(resetsAtSec: number): string {
  const remainMs = resetsAtSec * 1000 - Date.now();
  if (remainMs <= 0) return "まもなく解除";
  let sec = Math.floor(remainMs / 1000);
  const h = Math.floor(sec / 3600);
  sec -= h * 3600;
  const m = Math.floor(sec / 60);
  sec -= m * 60;
  if (h > 0) return `${h}時間${m}分`;
  if (m > 0) return `${m}分${sec}秒`;
  return `${sec}秒`;
}
