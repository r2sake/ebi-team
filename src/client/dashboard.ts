import type { AgentRecord, UsageAgent, UsageMessage, UsageRateLimits } from "../shared/protocol.ts";
import {
  backendBadge,
  backendReportsUsage,
  formatUsageCell,
  USAGE_UNSUPPORTED_TEXT,
  USAGE_UNSUPPORTED_TITLE,
} from "../shared/backendBadge.ts";

/**
 * 使用状況ダッシュボード。
 * REGISTRY 最上段「📊 ダッシュボード」を選んだときにメイン領域へ描画する DOM。
 * - アカウント枠: 5h / 7d のレート制限（使用率バー＋解除カウントダウン）。
 * - エビ別テーブル: id / backend / model / context% / 推定コスト$ / token 内訳。
 *   usage を報告しない backend（codex / gemini）の行は cost/context を「—（未対応）」と明示する
 *   （空欄にすると「壊れている」と誤読されるため。設計 §4.5 / Q-8）。
 * - 合計推定コスト。
 * データは WS `usage` で受信し、最新スナップショットを保持して再描画する。
 * cost は「推定」（Max サブスクの実請求とは別）である旨を注記する。
 */
export class Dashboard {
  /** 最新の usage スナップショット。未受信なら null。 */
  private latest: UsageMessage | null = null;
  /** 表示中か（非表示中はカウントダウン更新を止める）。 */
  private visible = false;
  /**
   * 最新の registry スナップショット（WS `registry` 由来）。
   * usage を報告しない backend のエビは usage が 1 度も届かないため、テーブルに現れない。
   * 「居るのに欠測」を可視化するため registry 側からも行を起こす。
   */
  private agents: AgentRecord[] = [];
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

  /** WS `registry` を受信したら最新のエビ一覧を保持し、表示中なら再描画する。 */
  updateAgents(agents: AgentRecord[]): void {
    this.agents = agents;
    if (this.visible) this.render();
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

    const hasUnsupported = this.agents.some((a) => !backendReportsUsage(a.backend));
    if (
      !u ||
      (u.agents.length === 0 && !hasUnsupported && !u.rateLimits.fiveHour && !u.rateLimits.sevenDay)
    ) {
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
      "コストは推定額（Max サブスクは実質サブスク内・実請求とは別）。値は各エビの statusLine 更新時に反映され、idle のエビは古くなることがあります。" +
      "codex / gemini は statusLine 相当の報告経路が無いため cost / context は「—（未対応）」と表示されます（欠測であって異常ではありません）。";
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
      "<tr><th>id</th><th>backend</th><th>model</th><th>context</th><th>推定$</th>" +
      "<th>input</th><th>output</th><th>cacheRead</th><th>cacheCreate</th></tr>";
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const rows = mergeUsageRows(u.agents, this.agents);
    if (rows.length === 0) {
      const tr = document.createElement("tr");
      const cellEl = document.createElement("td");
      cellEl.colSpan = 9;
      cellEl.className = "dash-waiting";
      cellEl.textContent = "データ待ち";
      tr.appendChild(cellEl);
      tbody.appendChild(tr);
    } else {
      for (const row of rows) {
        const a = row.usage;
        const bb = backendBadge(row.backend);
        const tr = document.createElement("tr");
        if (!bb.reportsUsage) tr.className = "dash-row-unsupported";
        tr.appendChild(td(row.id));
        tr.appendChild(td(`${bb.emoji} ${bb.label}`));
        tr.appendChild(td(a?.model ?? "-"));
        tr.appendChild(usageTd(row.backend, a?.contextUsedPct ?? null, (v) => `${v}%`));
        tr.appendChild(usageTd(row.backend, a?.costUsd ?? null, (v) => `$${v.toFixed(2)}`));
        tr.appendChild(usageTd(row.backend, a?.tokens.input ?? null, formatCount));
        tr.appendChild(usageTd(row.backend, a?.tokens.output ?? null, formatCount));
        tr.appendChild(usageTd(row.backend, a?.tokens.cacheRead ?? null, formatCount));
        tr.appendChild(usageTd(row.backend, a?.tokens.cacheCreation ?? null, formatCount));
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

/**
 * ダッシュボードのエビ別テーブル 1 行分（usage 受信済みかどうかに関わらず作る）。
 * usage が無い（＝報告しない backend / まだ届いていない）行は usage=null。
 */
export interface UsageRow {
  id: string;
  /** registry 由来の backend id（registry に居ないエビ＝ kill 済み等は undefined）。 */
  backend?: string;
  usage: UsageAgent | null;
}

/**
 * usage スナップショットと registry を突き合わせて表示行を作る純関数。
 * - usage を受信済みのエビはその値で表示（backend は registry から補う）。
 * - registry に居るが usage が無いエビのうち、**usage 非対応 backend**（codex / gemini）は
 *   行を起こして「—（未対応）」を出す（居るのに表から消えると欠測と気づけない）。
 * - usage 対応 backend でまだ届いていないエビは行を起こさない（従来どおり「データ待ち」）。
 */
export function mergeUsageRows(usage: UsageAgent[], agents: AgentRecord[]): UsageRow[] {
  const backendOf = new Map(agents.map((a) => [a.id, a.backend]));
  const seen = new Set<string>();
  const rows: UsageRow[] = [];
  for (const u of usage) {
    seen.add(u.id);
    rows.push({ id: u.id, backend: backendOf.get(u.id), usage: u });
  }
  for (const a of agents) {
    if (seen.has(a.id)) continue;
    if (backendReportsUsage(a.backend)) continue;
    rows.push({ id: a.id, backend: a.backend, usage: null });
  }
  return rows;
}

/** usage セル（非対応 backend は「—（未対応）」＋説明 title）。 */
function usageTd<T>(
  backend: string | null | undefined,
  value: T | null,
  format: (v: T) => string,
): HTMLTableCellElement {
  const text = formatUsageCell(backend, value, format);
  const cell = td(text);
  if (text === USAGE_UNSUPPORTED_TEXT) {
    cell.className = "dash-unsupported";
    cell.title = USAGE_UNSUPPORTED_TITLE;
  }
  return cell;
}

/** 数値を桁区切り文字列にする（formatUsageCell の format 引数）。 */
function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** セル生成ヘルパー。 */
function td(text: string): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.textContent = text;
  cell.title = text;
  return cell;
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
