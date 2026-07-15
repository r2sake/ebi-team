import { Pane } from "./pane.ts";
import { Dashboard } from "./dashboard.ts";
import {
  type ClientMessage,
  type ServerMessage,
  type AgentRecord,
} from "../shared/protocol.ts";

// ===== DOM 参照 =====
const stage = document.getElementById("stage") as HTMLElement;
const spawnBtn = document.getElementById("spawn-btn") as HTMLButtonElement;
const spawnCwd = document.getElementById("spawn-cwd") as HTMLInputElement;
const spawnUseWorktree = document.getElementById("spawn-use-worktree") as HTMLInputElement;
const spawnRepo = document.getElementById("spawn-repo") as HTMLInputElement;
const spawnBranch = document.getElementById("spawn-branch") as HTMLInputElement;
const connStatus = document.getElementById("conn-status") as HTMLElement;
const registryBody = document.querySelector("#registry-table tbody") as HTMLElement;
const noticeList = document.getElementById("notice-list") as HTMLElement;
// 監督・要約パネル（既定 OFF。supervisor 有効時のみ使う）。
const summaryPanel = document.getElementById("summary-panel") as HTMLElement;
const summaryAgent = document.getElementById("summary-agent") as HTMLElement;
const summaryBody = document.getElementById("summary-body") as HTMLElement;
const summaryClose = document.getElementById("summary-close") as HTMLButtonElement;

// ===== 状態 =====
const panes = new Map<string, Pane>();
let registry: AgentRecord[] = [];

// REGISTRY 最上段に常設する合成エントリ（ダッシュボード）。サーバ registry には入れない
// クライアント側の擬似エントリ。選択するとメイン領域に xterm ではなくダッシュボード DOM を出す。
const DASHBOARD_ID = "__dashboard__";

// 使用状況ダッシュボード（WS `usage` を受けて描画する）。
const dashboard = new Dashboard(document.getElementById("dashboard") as HTMLElement);

// 表示順: dashboard → master → supervisor → dynamic。同種は元の順を維持（Array.sort は V8 で安定）。
// 種別ソートにすることで、固定エビが自動再起動で末尾に来ても順序が崩れない。
// dashboard は合成エントリで master より上（-1）。
const KIND_ORDER: Record<string, number> = { dashboard: -1, master: 0, supervisor: 1, dynamic: 2 };
function sortAgents(agents: AgentRecord[]): AgentRecord[] {
  return [...agents].sort(
    (a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9),
  );
}
// メイン領域に単独表示している agent。未選択（＝空状態）なら null。
let activeId: string | null = null;
// spawn 直後に自動選択したい agent。registry 反映時に拾って選択する。
let pendingSelectId: string | null = null;
// 監督・要約機能が有効か（サーバの capabilities = サブスク claude CLI の有無で決まる）。
let supervisorEnabled = false;

// ===== WebSocket 接続（自動再接続つき）=====
let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

function connect(): void {
  ws = new WebSocket(wsUrl());

  ws.addEventListener("open", () => {
    connStatus.textContent = "接続済み";
    connStatus.className = "conn ok";
    sendMsg({ type: "list" });
    // 再接続時はサーバ側の購読集合がリセットされているので、
    // 既存ペイン分を再購読しておく（初回は panes が空なので no-op）。
    const ids = [...panes.keys()];
    if (ids.length > 0) sendMsg({ type: "subscribe", ids });
  });

  ws.addEventListener("close", () => {
    connStatus.textContent = "切断（再接続中…）";
    connStatus.className = "conn ng";
    if (reconnectTimer === null) {
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 1500);
    }
  });

  ws.addEventListener("error", () => ws?.close());

  ws.addEventListener("message", (ev) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data as string) as ServerMessage;
    } catch {
      return;
    }
    handleServerMessage(msg);
  });
}

function sendMsg(msg: ClientMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ===== サーバメッセージ処理 =====
function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "registry":
      registry = sortAgents(msg.agents);
      syncPanes();
      renderRegistry();
      break;
    case "output":
      panes.get(msg.id)?.write(msg.data);
      break;
    case "scrollback":
      // 再アタッチ: subscribe 初回に届くスクロールバック一括。
      // 既存内容を一旦クリアしてから書き戻すことで、
      // （同一セッションでの WS 切断→再接続による）二重表示を防ぐ。
      panes.get(msg.id)?.restoreScrollback(msg.data);
      break;
    case "spawned":
      // 直後に registry メッセージが来てペインが生成される。
      // 新規 spawn した agent を自動でメインに出すため、選択予約しておく。
      pendingSelectId = msg.agent.id;
      break;
    case "exited":
      removePane(msg.id);
      addNotice(msg.id, `終了（exitCode=${msg.exitCode ?? "n/a"}）`);
      break;
    case "status": {
      const rec = registry.find((a) => a.id === msg.id);
      if (rec) rec.status = msg.status;
      panes.get(msg.id)?.setStatus(msg.status);
      renderRegistry();
      break;
    }
    case "notice":
      // 要約待ちだった agent への notice なら、要約ボタンのローディングを解除する。
      if (msg.id === summarizingId) clearSummarizing();
      addNotice(msg.id, msg.text);
      break;
    case "error":
      addNotice("system", `エラー: ${msg.text}`);
      break;
    case "capabilities":
      // サーバ能力に応じて要約 UI の有無を切り替える。
      // 既存ペインは再生成して要約ボタンの有無を反映する（接続/再接続時のみ・低頻度）。
      if (msg.supervisor !== supervisorEnabled) {
        supervisorEnabled = msg.supervisor;
        rebuildPanes();
      } else {
        supervisorEnabled = msg.supervisor;
      }
      break;
    case "summary":
      clearSummarizing();
      showSummary(msg.id, msg.text);
      break;
    case "usage":
      // 使用状況スナップショット。ダッシュボード表示中なら即描画に反映される。
      dashboard.update(msg);
      break;
  }
}

// ===== ペイン同期（registry に合わせて生成/削除）=====
// master-detail: 全ペインを stage に並べておくが、表示は activeId の 1 枚だけ。
// 非表示ペインも PTY / xterm は生かし続け、出力は裏で受信し続ける。
function syncPanes(): void {
  const ids = new Set(registry.map((a) => a.id));

  // 無くなった agent のペインを削除。
  for (const id of [...panes.keys()]) {
    if (!ids.has(id)) removePane(id);
  }

  // 新規 agent のペインを生成（DOM には足すが既定は非表示）。
  for (const rec of registry) {
    if (!panes.has(rec.id)) {
      const pane = new Pane(
        rec,
        (id, data) => sendMsg({ type: "input", id, data }),
        (id, cols, rows) => sendMsg({ type: "resize", id, cols, rows }),
        (id) => sendMsg({ type: "kill", id }),
        (id) => setActive(id),
        // 監督有効時のみ要約コールバックを渡す（OFF 時はボタン自体を出さない）。
        supervisorEnabled ? (id) => requestSummary(id) : undefined,
      );
      pane.setStatus(rec.status);
      pane.setVisible(false);
      panes.set(rec.id, pane);
      stage.appendChild(pane.el);
      // per-pane 購読: 表示中の全 agent を購読しておく（裏での溜め込み挙動を維持）。
      // 将来 per-pane に絞る場合はここを activeId だけの購読に変えられる。
      sendMsg({ type: "subscribe", id: rec.id });
    }
  }

  // spawn 直後の自動選択（その agent が registry に反映されたら拾う）。
  if (pendingSelectId && panes.has(pendingSelectId)) {
    const target = pendingSelectId;
    pendingSelectId = null;
    setActive(target);
    return;
  }

  // ダッシュボードは合成エントリで panes には無いが、有効な選択として維持する。
  if (activeId === DASHBOARD_ID) {
    applyVisibility();
    renderEmpty();
  } else if (!activeId || !panes.has(activeId)) {
    // 未選択なら先頭の生存 agent を選ぶ。いなければダッシュボードを既定選択にする
    // （常設エントリなので「何も無い」状態を避けられる）。
    setActive(registry.length > 0 ? registry[0].id : DASHBOARD_ID);
  } else {
    // 既存選択を維持しつつ表示・ハイライトを反映。
    applyVisibility();
    renderEmpty();
  }
}

function removePane(id: string): void {
  const pane = panes.get(id);
  if (!pane) return;
  // 購読解除（kill/exit 時）。
  sendMsg({ type: "unsubscribe", id });
  pane.dispose();
  panes.delete(id);
  // 選択中だった場合は別の生存 agent にフォールバック（いなければダッシュボード）。
  if (activeId === id) {
    const next = [...panes.keys()][0] ?? DASHBOARD_ID;
    setActive(next);
  }
}

// ===== 選択（master-detail の切り替え）=====
function setActive(id: string | null): void {
  activeId = id;
  applyVisibility();
  renderRegistry();
  renderEmpty();
}

// activeId に合わせて各ペインの表示/非表示を反映する。
// ダッシュボード選択時は全 xterm ペインを隠し、ダッシュボード DOM を出す。
function applyVisibility(): void {
  const showDashboard = activeId === DASHBOARD_ID;
  dashboard.setVisible(showDashboard);
  for (const [pid, pane] of panes) pane.setVisible(!showDashboard && pid === activeId);
}

// ===== 空状態（未選択 / 全 agent 終了）=====
function renderEmpty(): void {
  const existing = stage.querySelector(".empty");
  // ダッシュボード表示中は空状態を出さない（メイン領域はダッシュボードが占める）。
  const isEmpty =
    activeId !== DASHBOARD_ID && (activeId === null || !panes.has(activeId));
  if (isEmpty) {
    if (!existing) {
      const div = document.createElement("div");
      div.className = "empty";
      div.textContent =
        "エビが選択されていません。左上の「＋ エビを追加」で spawn し、右の REGISTRY から選んでください。";
      stage.appendChild(div);
    }
  } else {
    existing?.remove();
  }
}

// ===== サイドバー描画 =====
function renderRegistry(): void {
  registryBody.innerHTML = "";

  // 最上段に合成エントリ「📊 ダッシュボード」を常設する（クリックでダッシュ画面へ）。
  {
    const tr = document.createElement("tr");
    tr.className = "agent-row dashboard-row" + (activeId === DASHBOARD_ID ? " active" : "");
    tr.title = "クリックで使用状況ダッシュボードを表示";
    tr.addEventListener("click", () => setActive(DASHBOARD_ID));
    const td = document.createElement("td");
    td.colSpan = 6;
    td.textContent = "📊 ダッシュボード";
    tr.appendChild(td);
    registryBody.appendChild(tr);
  }

  for (const a of registry) {
    const tr = document.createElement("tr");
    // REGISTRY 行が agent 選択リストを兼ねる。クリックでメインに単独表示。
    // isolated は視覚的に区別（行を淡くする）。
    tr.className =
      "agent-row" +
      (a.id === activeId ? " active" : "") +
      (a.mode === "isolated" ? " isolated" : "") +
      (a.kind !== "dynamic" ? ` kind-${a.kind}` : "");
    tr.title = "クリックでメイン表示";
    tr.addEventListener("click", () => setActive(a.id));

    // id セル: 固定エビは種別バッジ（master/supervisor）を併記する。
    const idTd = document.createElement("td");
    idTd.title = a.id;
    idTd.append(document.createTextNode(a.id));
    if (a.kind !== "dynamic") {
      const badge = document.createElement("span");
      badge.className = `kind-badge kind-${a.kind}`;
      badge.textContent = a.kind === "master" ? "👑" : "🛡";
      badge.title = `${a.kind}（削除不可）${a.model ? ` / model: ${a.model}` : ""}`;
      idTd.append(document.createTextNode(" "), badge);
    }

    // mode トグルセル（クリックで connected ⇄ isolated）。行選択へ伝播させない。
    const modeTd = document.createElement("td");
    const modeBtn = document.createElement("button");
    modeBtn.className = "mode-toggle " + a.mode;
    modeBtn.textContent = a.mode === "connected" ? "🔗 connected" : "⛓️ isolated";
    modeBtn.title = "クリックで connected/isolated を切替";
    modeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const next = a.mode === "connected" ? "isolated" : "connected";
      sendMsg({ type: "setMode", id: a.id, mode: next });
    });
    modeTd.appendChild(modeBtn);

    // branch セル: worktree 由来（branch あり）は 🌿 アイコンで区別。
    const branchTd = cell(a.branch ? `🌿 ${a.branch}` : "-");
    if (a.branch) branchTd.className = "branch-cell";

    const cells = [
      idTd,
      cell(a.status, `status-${a.status}`),
      modeTd,
      branchTd,
      cell(a.cwd),
      cell(a.pid === null ? "-" : String(a.pid)),
    ];
    for (const c of cells) tr.appendChild(c);
    registryBody.appendChild(tr);
  }
}

function cell(text: string, cls?: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text;
  td.title = text;
  if (cls) td.className = cls;
  return td;
}

function addNotice(id: string, text: string): void {
  const li = document.createElement("li");
  const time = new Date().toLocaleTimeString("ja-JP");
  li.textContent = `[${time}] ${id}: ${text}`;
  noticeList.prepend(li);
  // 直近 50 件のみ保持。
  while (noticeList.children.length > 50) noticeList.lastChild?.remove();
}

// ===== 監督・要約（既定 OFF。supervisor 有効時のみ動く）=====
// いま要約待ちの agent id（ローディング表示の対象）。
let summarizingId: string | null = null;

/** 要約をサーバへ要求し、対象ペインをローディング表示にする。 */
function requestSummary(id: string): void {
  if (!supervisorEnabled) return;
  // 直前の要約待ちがあればそのローディングは解除しておく。
  if (summarizingId && summarizingId !== id) clearSummarizing();
  summarizingId = id;
  panes.get(id)?.setSummarizing(true);
  sendMsg({ type: "summarize", id });
}

/** 要約待ちのローディング表示を解除する。 */
function clearSummarizing(): void {
  if (summarizingId) panes.get(summarizingId)?.setSummarizing(false);
  summarizingId = null;
}

/** 要約結果をパネルに表示する。 */
function showSummary(id: string, text: string): void {
  summaryAgent.textContent = `(${id})`;
  // テキストは textContent で安全に表示（HTML 解釈しない）。改行は CSS の white-space で保持。
  summaryBody.textContent = text;
  summaryPanel.hidden = false;
}

summaryClose.addEventListener("click", () => {
  summaryPanel.hidden = true;
});

/**
 * supervisor の有効/無効が変わったとき、全ペインを作り直して要約ボタンの有無を反映する。
 * 接続/再接続時のみ・低頻度なので作り直しで問題ない。選択状態は維持する。
 */
function rebuildPanes(): void {
  for (const id of [...panes.keys()]) {
    const pane = panes.get(id);
    // 購読を解除してから捨てる。直後の syncPanes での再 subscribe で
    // サーバが scrollback を再送し、新しい xterm に画面が復元される。
    sendMsg({ type: "unsubscribe", id });
    pane?.dispose();
    panes.delete(id);
  }
  clearSummarizing();
  summaryPanel.hidden = true;
  syncPanes();
}

// ===== 操作ハンドラ =====
// worktree チェックで repo / branch 入力欄の表示を切り替える。
spawnUseWorktree.addEventListener("change", () => {
  const on = spawnUseWorktree.checked;
  spawnRepo.hidden = !on;
  spawnBranch.hidden = !on;
});

spawnBtn.addEventListener("click", () => {
  const cwd = spawnCwd.value.trim();
  if (spawnUseWorktree.checked) {
    const repoPath = spawnRepo.value.trim();
    const branch = spawnBranch.value.trim();
    sendMsg({
      type: "spawn",
      cwd: cwd || undefined,
      useWorktree: true,
      repoPath: repoPath || undefined,
      branch: branch || undefined,
    });
  } else {
    sendMsg({ type: "spawn", cwd: cwd || undefined });
  }
});

// ウィンドウリサイズ時は、表示中の agent だけ fit&resize すれば良い
// （隠れているものは表示に切り替えた瞬間に fit される）。
window.addEventListener("resize", () => {
  if (activeId) panes.get(activeId)?.refit();
});

connect();
