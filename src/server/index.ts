// .env をリポジトリルートから最初に読み込む（他 import が module-level で process.env を読む前に適用）。
import { loadedEnvKeys } from "./env.ts";
import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { Registry, hasControlBridge, isNotifyMode, type WorktreeMeta } from "./registry.ts";
import { Mailbox } from "./mailbox.ts";
import type { SpawnConfig, AgentHandlers, LaunchParams } from "./agent.ts";
import { BASE_ALLOWED_DEV_CHANNELS } from "./agent.ts";
import { addWorktree, removeWorktree } from "./git.ts";
import { Supervisor } from "./supervisor.ts";
import {
  loadFixedEbi,
  loadRawCustomRoles,
  loadDevChannelsAllowlist,
  buildClaudeArgs,
  validatePermissionMode,
  DEFAULT_PERMISSION_MODE,
} from "./config.ts";
import { EBI_ROLES, resolveRole, registerCustomRoles, type EbiMcpRole } from "./roles.ts";
import { FixedEbiManager } from "./fixedEbi.ts";
import { createControlApi, type GeneralizedSpawnParams } from "./control.ts";
import { UsageStore } from "./usageStore.ts";
import { ViewerRegistry } from "./viewerRegistry.ts";
import {
  loadAuthConfig,
  isLoopback,
  authorize,
  tokenMatches,
  buildAuthCookie,
  loginPageHtml,
  checkRateLimit,
  recordFailure,
  recordSuccess,
  delay,
  FAILURE_DELAY_MS,
} from "./auth.ts";
import {
  type ClientMessage,
  type ServerMessage,
  type AgentStatus,
  type SpawnMessage,
  type SubscribeMessage,
  type UnsubscribeMessage,
} from "../shared/protocol.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ===== 設定（環境変数で上書き可能）=====
const PORT = Number(process.env.EBI_PORT ?? 8787);
// bind するホスト。制御API を外部に晒さないため既定 127.0.0.1（loopback 限定）。
const HOST = process.env.EBI_HOST ?? "127.0.0.1";
// アプリ層トークン認証の設定（EBI_AUTH_TOKEN）。
// 未設定なら token=null（＝非 loopback からのアクセスは全拒否の安全側デフォルト）。
// loopback（母艦ローカル・内部 MCP 呼び）は token の有無に関わらず常に無認証で通す。
const authConfig = loadAuthConfig();
// spawn する対象コマンド。claude が PATH に無い環境では EBI_COMMAND=bash 等で fallback。
const COMMAND = process.env.EBI_COMMAND ?? "claude";
const COMMAND_ARGS = process.env.EBI_ARGS ? process.env.EBI_ARGS.split(" ") : [];
// agent のデフォルト cwd。
const DEFAULT_CWD = process.env.EBI_DEFAULT_CWD ?? process.cwd();
// idle 判定しきい値（ms）。出力がこの時間止まったら idle とみなす。
const IDLE_THRESHOLD_MS = Number(process.env.EBI_IDLE_MS ?? 900);
// send_message が ready（入力受付）になるまで待つ最大時間（ms）。超えたら ready timeout。
const READY_WAIT_MS = Number(process.env.EBI_READY_WAIT_MS ?? 30000);
// send_message が「notification 経路の購読確立」を待つ最大時間（ms）。
// spawn 直後は claude 起動→MCP 接続→control-server ブリッジの初回 subscribe まで数秒かかる。
// この時間内に購読が確立しなければ、待たずに従来の PTY 経路（ready 待ち+inject）へフォールバックする。
const SUBSCRIBE_WAIT_MS = Number(process.env.EBI_SUBSCRIBE_WAIT_MS ?? 20000);
// registry のダンプ先。
const DUMP_PATH = process.env.EBI_DUMP_PATH ?? join(process.cwd(), ".ebi-team", "registry.json");
// 再アタッチ用スクロールバックのリングバッファ上限（バイト相当・既定 256KB）。
const SCROLLBACK_BYTES = Number(process.env.EBI_SCROLLBACK_BYTES ?? 256 * 1024);
// 固定エビ config のパス（無ければ固定エビ機能 OFF）。
const CONFIG_PATH = process.env.EBI_CONFIG_PATH ?? join(process.cwd(), "ebi-team.config.json");
// 役割別 MCP config（reply_to_master 等の最小権限）のパス。
// dev（tsx 実行・src 起点）か本番（dist 起点）かを __dirname で判定して既定を選ぶ。
// env EBI_ENGINEER_MCP_CONFIG で明示上書き可（テスト/特殊配置用）。
const RUNNING_FROM_SRC = __dirname.includes(`${join("src", "server")}`);
function defaultMcpConfigPath(mcpRole: EbiMcpRole): string {
  return join(
    process.cwd(),
    ".ebi-team",
    RUNNING_FROM_SRC ? `${mcpRole}-control.dev.mcp.json` : `${mcpRole}-control.mcp.json`,
  );
}
const ROLE_MCP_CONFIG: Record<EbiMcpRole, string> = {
  engineer: process.env.EBI_ENGINEER_MCP_CONFIG ?? defaultMcpConfigPath("engineer"),
};
// --dangerously-load-development-channels に渡す channel 指定子。
// 手動設定の MCP サーバは `server:<mcpServersキー名>` 形式でタグ付けが必須
// （素の "ebi-control" だと claude が起動時エラーで即終了する。実機で確認済み）。
// キー名は gen-master-mcp.mjs の生成キー "ebi-control" と一致していること。
const EBI_CONTROL_CHANNEL_SPEC = "server:ebi-control";

const spawnConfig: SpawnConfig = {
  command: COMMAND,
  args: COMMAND_ARGS,
  idleThresholdMs: IDLE_THRESHOLD_MS,
  scrollbackBytes: SCROLLBACK_BYTES,
  // 起動ゲート自動応答の許可リスト（正確値）。組込みを初期値に持ち、起動時に
  // ebi-team.config.json の devChannelsAllowlist をマージする（loadAndApplyDevChannelsAllowlist）。
  // Registry は本オブジェクト参照を保持するため、listen 前のマージが後続の spawn に反映される。
  devChannelsAllowlist: [...BASE_ALLOWED_DEV_CHANNELS],
};

// notification 注入方式（mcp notifications/claude/channel）の郵便受け。
// 各エビの制御MCP ブリッジ（src/mcp/control-server.ts）が /control/subscribe に long-poll し、
// ここに push されたメッセージを受け取って自分のセッションへ notification として注入する。
const mailbox = new Mailbox();

const registry = new Registry(spawnConfig, DUMP_PATH, mailbox);

// 固定エビ（master/supervisor）の自動起動・自動再起動マネージャ。
// config が無ければ start() に空配列が渡るだけで何も起きない。
const fixedEbi = new FixedEbiManager(registry);

// 監督・要約（既定 OFF）。OFF / キー無しなら enabled=false で API は一切呼ばない。
const supervisor = new Supervisor();

// 使用状況（usage）ストア。各エビの statusLine が /control/usage に POST してくる
// cost/context/model と、アカウント単位の rate_limits を最新値で保持する。
const usageStore = new UsageStore();

// viewer（読み取り専用の md/txt プレビュー）コレクション。master の open_viewer で開き、
// クライアントは registry サイドバーに合成行として出す。プロセスは持たない。
const viewerRegistry = new ViewerRegistry();

// ===== 接続中の WebSocket クライアント集合 =====
const clients = new Set<WebSocket>();

// ===== per-pane 購読（output の購読制）=====
// 各 WS 接続が「どの agent の output を受け取るか」を保持する。
// output はこの集合に含まれる agent の分だけ各接続へ送る。
// MVP ではクライアントが表示中の全 agent を購読するため実挙動は全配信と同じだが、
// 将来 per-pane に絞れるようサーバ側にフィルタの土台を入れておく。
const subscriptions = new WeakMap<WebSocket, Set<string>>();

function subsOf(ws: WebSocket): Set<string> {
  let set = subscriptions.get(ws);
  if (!set) {
    set = new Set<string>();
    subscriptions.set(ws, set);
  }
  return set;
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMessage): void {
  const text = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(text);
  }
}

/** 指定 agent の output を、その agent を購読している接続にだけ配信する。 */
function broadcastOutput(id: string, data: string): void {
  const text = JSON.stringify({ type: "output", id, data } satisfies ServerMessage);
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (subsOf(ws).has(id)) ws.send(text);
  }
}

function broadcastRegistry(): void {
  broadcast({ type: "registry", agents: registry.list() });
}

/** 現在の使用状況スナップショットを全クライアントへ broadcast する。 */
function broadcastUsage(): void {
  broadcast(usageStore.snapshot());
}

/** 現在の viewer 一覧を全クライアントへ broadcast する（open/close 時）。 */
function broadcastViewers(): void {
  broadcast({ type: "viewers", viewers: viewerRegistry.list() });
}

/**
 * worktree 由来 agent の kill/exit 後に git worktree を remove する。
 * 未コミット変更等で remove が失敗した場合は **force せず**、残置して notice で通知する
 * （データ保護優先）。成功時も通知する。
 */
async function cleanupWorktree(id: string, meta: WorktreeMeta): Promise<void> {
  try {
    const result = await removeWorktree(meta.repo, meta.path);
    if (result.removed) {
      broadcast({ type: "notice", id, text: `worktree を削除しました: ${meta.path}` });
    } else {
      broadcast({
        type: "notice",
        id,
        text: `未コミット変更等のため worktree を残置しました（${meta.path}）: ${result.reason ?? "理由不明"}`,
      });
    }
  } catch (err) {
    broadcast({ type: "notice", id, text: `worktree 削除中にエラー: ${(err as Error).message}` });
  }
}

// Agent 由来イベントは全クライアントへブロードキャストする
// （どのペインがどの agent を見ているかはクライアント側でフィルタする）。
const handlers: AgentHandlers = {
  onData(id, data) {
    // output は購読している接続にだけ配信する（per-pane 購読）。
    broadcastOutput(id, data);
  },
  onStatus(id, status: AgentStatus) {
    registry.touch();
    broadcast({ type: "status", id, status });
  },
  onExit(id, exitCode) {
    // プロセスが自然終了したら registry からも除去する。
    // worktree 由来ならクリーンアップ用にメタを除去前に控えておく。
    const meta = registry.worktreeMetaOf(id);
    // 固定エビかどうかは「マネージャの管理対象か」で判定する
    // （remove で Agent が消える前に控える）。
    const managed = fixedEbi.manages(id);
    registry.remove(id);
    broadcast({ type: "exited", id, exitCode });
    broadcastRegistry();
    if (meta) void cleanupWorktree(id, meta);
    // 固定エビなら自動再起動を予約する（crashloop 時はマネージャ側で停止）。
    if (managed) fixedEbi.onExit(id, handlers);
  },
  onNotice(id, text) {
    broadcast({ type: "notice", id, text });
  },
  onIdleNotify(id) {
    // [B] idle 自動通知（保険）。busy→idle のエッジで、master/supervisor 以外かつ
    // ready 済みのエビが「直近に A の明示リプライ無し・クールダウン超過」のとき Agent から
    // 呼ばれる。本文抽出はせず「待機に入った／read_scrollback で確認可」の軽い通知だけ送る。
    const result = registry.reverseInject(
      id,
      "master",
      "待機に入りました。詳細は read_scrollback で確認できます。",
      "idle",
    );
    if (result.delivered.length === 0 && result.rejected.length > 0) {
      // master が居ない等で配信不能でも致命ではない（保険の通知なので notice のみ）。
      console.warn(`[ebi-team] idle 自動通知の配信不可（${id}）: ${result.rejected[0]?.reason}`);
    }
  },
};

// ===== HTTP サーバ（本番ビルドの静的配信。dev は Vite が担当）=====
// emit 後の構成: dist/server/server/index.js → クライアントは dist/client。
const CLIENT_DIST = join(__dirname, "..", "..", "client");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// 127.0.0.1 限定の制御API（master 仲介の stdio 制御MCP から叩く）。
// inject はここで registry.resolveAndInject をラップする（WS 経由と同ロジック）。
const controlApi = createControlApi({
  registry,
  spawnAgent,
  inject: (to, from, message) => registry.resolveAndInject(to, from, message),
  sendMessage,
  broadcastRegistry,
  summarize: summarizeAgent,
  ingestUsage: (ebiId, json) => {
    usageStore.update(ebiId, json);
    // 更新のたびに全クライアントへ最新スナップショットを配信する。
    broadcastUsage();
  },
  // 各エビの制御MCP ブリッジが自分宛メッセージを long-poll 購読するための経路。
  // 初回購読の確立はサーバログに出す（notification 経路が生きているかの観測点）。
  subscribe: (id, timeoutMs) => {
    if (!mailbox.everSubscribed(id)) {
      console.log(`[ebi-team] notification 購読が確立: id=${id}`);
    }
    return mailbox.subscribe(id, timeoutMs);
  },
  // master の open_viewer からの viewer 追加。登録後に viewers を broadcast する。
  openViewer: async (path, title) => {
    const rec = await viewerRegistry.open({ path, title });
    broadcastViewers();
    return rec;
  },
});

/** HTML を期待するリクエスト（ブラウザ遷移）かを Accept ヘッダで大まかに判定する。 */
function wantsHtml(req: IncomingMessage): boolean {
  const accept = req.headers["accept"];
  return typeof accept === "string" && accept.includes("text/html");
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const urlPath = url.pathname;
  const loopback = isLoopback(req);

  // ---- ログイン導線（認証ゲートより前・常に到達可能）----
  // GET /login: トークン入力ページを返す。POST /login: 照合して Cookie を発行する。
  if (urlPath === "/login" && (req.method ?? "GET") === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(loginPageHtml());
    return;
  }
  if (urlPath === "/login" && req.method === "POST") {
    // レート制限（ブルートフォース対策）。ブロック中は 429。
    const rl = checkRateLimit(req);
    if (rl.blocked) {
      res.writeHead(429, {
        "Content-Type": "application/json; charset=utf-8",
        "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
      });
      res.end(JSON.stringify({ error: "too many attempts" }));
      return;
    }
    let token = "";
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const parsed = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      token = typeof parsed?.token === "string" ? parsed.token : "";
    } catch {
      token = "";
    }
    // token 未設定運用（authConfig.token=null）ではログインは常に失敗させる
    // （非 loopback は安全側デフォルトで拒否のため、cookie を配っても意味がない）。
    if (authConfig.token && tokenMatches(token, authConfig.token)) {
      recordSuccess(req);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": buildAuthCookie(authConfig.token),
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    recordFailure(req);
    await delay(FAILURE_DELAY_MS);
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "invalid token" }));
    return;
  }

  // ---- 認証ゲート（loopback は常に素通り／非 loopback は token 必須）----
  const auth = authorize(req, loopback, authConfig, url.searchParams);
  if (!auth.ok) {
    if (urlPath.startsWith("/control/")) {
      // 制御API は JSON で 401（内部 MCP からの loopback 呼びはここに来ない）。
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (wantsHtml(req)) {
      // ブラウザ遷移はログイン画面へ誘導する。
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Unauthorized");
    return;
  }

  // 制御API（/control/*）を最優先で処理する。該当すれば静的配信へは進まない。
  if (await controlApi(req, res, urlPath, url.searchParams)) return;
  let filePath = join(CLIENT_DIST, normalize(urlPath === "/" ? "/index.html" : urlPath));
  // ディレクトリトラバーサル防止。
  if (!filePath.startsWith(CLIENT_DIST)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    // SPA フォールバック（ビルド未実施でも dev は Vite を使うので問題なし）。
    res.writeHead(404);
    res.end("Not Found（dev では Vite の 5173 番を使ってください）");
  }
});

// ===== WebSocket =====
// HTTP 入口と同じ二段判定でハンドシェイクをゲートする。ここを塞がないと WS だけ
// 素通りしてしまう（plan §7-2）。token は Cookie ebi_auth / ?token= から拾う。
const wss = new WebSocketServer({
  server: httpServer,
  path: "/ws",
  verifyClient: (info, cb) => {
    const req = info.req;
    const loopback = isLoopback(req);
    const query = new URL(req.url ?? "/ws", "http://127.0.0.1").searchParams;
    const auth = authorize(req, loopback, authConfig, query);
    if (auth.ok) {
      cb(true);
    } else {
      cb(false, 401, "Unauthorized");
    }
  },
});

wss.on("connection", (ws) => {
  clients.add(ws);
  // 接続直後にサーバ能力（監督が有効か）を送る。クライアントはこれで要約 UI の出し分けをする。
  send(ws, { type: "capabilities", supervisor: supervisor.enabled });
  // 接続直後に現在の registry を送る。
  send(ws, { type: "registry", agents: registry.list() });
  // 接続直後に現在の使用状況スナップショットも送る（ダッシュボードの初期表示用）。
  send(ws, usageStore.snapshot());
  // 接続直後に現在の viewer 一覧も送る（再接続時に開いている viewer を復元するため）。
  send(ws, { type: "viewers", viewers: viewerRegistry.list() });

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send(ws, { type: "error", text: "不正な JSON です" });
      return;
    }
    handleClientMessage(ws, msg);
  });

  ws.on("close", () => {
    clients.delete(ws);
    subscriptions.delete(ws);
  });
  ws.on("error", () => {
    clients.delete(ws);
    subscriptions.delete(ws);
  });
});

/** subscribe/unsubscribe の id 指定（id 単体 / ids 配列）を正規化する。 */
function idsOf(msg: SubscribeMessage | UnsubscribeMessage): string[] {
  const ids: string[] = [];
  if (msg.id) ids.push(msg.id);
  if (msg.ids) ids.push(...msg.ids);
  return ids;
}

function handleClientMessage(ws: WebSocket, msg: ClientMessage): void {
  switch (msg.type) {
    case "spawn": {
      void handleSpawn(ws, msg);
      break;
    }
    case "kill": {
      // 固定エビ（pinned・master/supervisor や minaebi 等の常駐エビ）は削除不可。
      // kill を拒否して notice を返す。
      if (registry.isPinned(msg.id)) {
        send(ws, {
          type: "notice",
          id: msg.id,
          text: "固定エビ（削除不可の常駐エビ）は削除できません",
        });
        break;
      }
      // worktree 由来ならクリーンアップ用にメタを除去前に控える。
      const meta = registry.worktreeMetaOf(msg.id);
      const ok = registry.remove(msg.id);
      if (ok) {
        broadcast({ type: "exited", id: msg.id, exitCode: null });
        broadcastRegistry();
        if (meta) void cleanupWorktree(msg.id, meta);
      } else {
        send(ws, { type: "error", text: `agent が見つかりません: ${msg.id}` });
      }
      break;
    }
    case "input": {
      registry.get(msg.id)?.write(msg.data);
      break;
    }
    case "resize": {
      registry.get(msg.id)?.resize(msg.cols, msg.rows);
      break;
    }
    case "setMode": {
      const ok = registry.setMode(msg.id, msg.mode);
      if (ok) {
        broadcastRegistry();
      } else {
        send(ws, { type: "error", text: `agent が見つかりません: ${msg.id}` });
      }
      break;
    }
    case "subscribe": {
      const set = subsOf(ws);
      for (const id of idsOf(msg)) {
        // 既に購読済みなら scrollback を再送しない（重複防止のガード）。
        // 「初回 subscribe 時のみ」スクロールバックを一括送信する。
        const isNew = !set.has(id);
        set.add(id);
        if (!isNew) continue;
        const agent = registry.get(id);
        if (!agent) continue;
        const scrollback = agent.getScrollback();
        if (scrollback.length > 0) {
          // 順序保証: scrollback を購読集合に入れた「後」かつ live output 配信の前に
          // この接続へ一括送信する。以降の onData→broadcastOutput は scrollback の後に届く。
          send(ws, { type: "scrollback", id, data: scrollback });
        }
      }
      break;
    }
    case "unsubscribe": {
      const set = subsOf(ws);
      for (const id of idsOf(msg)) set.delete(id);
      break;
    }
    case "list": {
      send(ws, { type: "registry", agents: registry.list() });
      break;
    }
    case "summarize": {
      void handleSummarize(ws, msg.id);
      break;
    }
    case "closeViewer": {
      // viewer を閉じる（プロセスは持たないので kill とは別経路）。
      if (viewerRegistry.close(msg.id)) broadcastViewers();
      break;
    }
    case "listDir": {
      // ユーザーが自分でファイルを開くためのファイルピッカーのディレクトリ列挙。
      // 許可ルート配下に限定して検証（ルート外・symlink 脱出・非ディレクトリは拒否）。
      void (async () => {
        try {
          const listing = await viewerRegistry.listDir(msg.path);
          send(ws, { type: "dirListing", listing });
        } catch (err) {
          // ルート外の存在有無を漏らさない汎用メッセージ（viewerRegistry 側で整形済み）。
          send(ws, { type: "dirListing", error: (err as Error).message });
        }
      })();
      break;
    }
    case "openViewer": {
      // ユーザー操作による viewer オープン。master の open_viewer と同一の
      // ViewerRegistry.open 検証を通す（許可ルート/拡張子/サイズ/symlink 脱出）。
      // 成功時は viewers を broadcast（既存の自動フォーカス経路に載る）。失敗は notice。
      void (async () => {
        try {
          await viewerRegistry.open({ path: msg.path, title: msg.title });
          broadcastViewers();
        } catch (err) {
          send(ws, { type: "notice", id: "viewer-open", text: `ファイルを開けません: ${(err as Error).message}` });
        }
      })();
      break;
    }
    default: {
      send(ws, { type: "error", text: "未知の message type です" });
    }
  }
}

/**
 * spawn 処理（WS 経由）。worktree 有効時は git worktree を切ってから隔離パスで起動する。
 * worktree 無効時は従来どおり cwd 直指定で起動する。
 * 失敗時は WS へ error を返す。
 */
async function handleSpawn(ws: WebSocket, msg: SpawnMessage): Promise<void> {
  try {
    await spawnAgent({ id: msg.id, cwd: msg.cwd, useWorktree: msg.useWorktree, repoPath: msg.repoPath, branch: msg.branch });
  } catch (err) {
    send(ws, { type: "error", text: `spawn 失敗: ${(err as Error).message}` });
  }
}

/**
 * spawn の中核（WS / 制御API 共通）。
 * model / appendSystemPrompt / permissionMode / kind まで受けられるよう一般化し、
 * engineer 等の動的エビを制御API からも起動できるようにする。
 * worktree 有効時は git worktree を切ってから隔離パスで起動する。
 * spawned / registry のブロードキャストもここで行い、起動した agent id を返す。
 */
async function spawnAgent(params: GeneralizedSpawnParams): Promise<string> {
  const cwd = params.cwd && params.cwd.trim() ? params.cwd.trim() : DEFAULT_CWD;
  const command = spawnConfig.command;

  // 役割（EBI_ROLES）を解決する。後方互換: asEngineer=true は role="engineer" と等価。
  // 未知の role 文字列は 400 相当のエラーにする（黙って素の dynamic にしない）。
  const roleId = params.role ?? (params.asEngineer ? "engineer" : undefined);
  const role = resolveRole(roleId);
  if (roleId && !role) {
    // 許容ロールは EBI_ROLES のキーから動的に生成する（カスタム役割を足せば自動で反映される）。
    const allowed = Object.keys(EBI_ROLES).join(", ");
    throw new Error(`role が不正です: ${roleId}（許容: ${allowed}）`);
  }

  // 適用優先度: 明示指定 > 役割既定 > サーバ既定。
  const permissionMode = params.permissionMode
    ? validatePermissionMode(params.permissionMode)
    : (role?.permissionMode ?? DEFAULT_PERMISSION_MODE);
  const appendSystemPrompt = params.appendSystemPrompt ?? role?.appendSystemPrompt ?? null;
  const model = params.model ?? role?.defaultModel ?? null;

  // 役割付きなら ebi-control MCP（最小権限・reply_to_master 等）を追加する。
  // - claude command 時のみ --mcp-config を足す（bash 等の非 claude command には付けない＝
  //   既存 buildClaudeArgs の「非 claude にフラグを付けない」方針と矛盾させない）。
  // - --strict-mcp-config は付けない。作業に必要な既存 MCP 環境を保ちつつ、
  //   ebi-control を「追加」で持たせたいため（strict だと他の MCP が落ちる）。
  // - notify モードが有効なときだけ --dangerously-load-development-channels server:ebi-control
  //   を足し、ebi-control MCP をセッションの channel として register する。これが無いと
  //   `notifications/claude/channel` が harness の channels allowlist 判定で skip され、
  //   notification 注入が成立しない（2026-07-11 harness バイナリ解析＋実機検証で確定。
  //   capability 宣言は src/mcp/control-server.ts 側）。サーバ名は mcp-config の mcpServers キー
  //   （scripts/gen-master-mcp.mjs の "ebi-control"）に一致させる。
  //   このフラグを付けた claude は起動時に development channels 警告ダイアログを出すが、
  //   agent.ts の起動ゲート自動応答（maybeAnswerStartupGates）が "1"+Enter で越える
  //   （運用者承認のもと有効化・live e2e 19/20 OK）。安全限定＝dev-channels 値が
  //   server:ebi-control ちょうど1個のときのみ自動応答（別サーバ名・複数指定は応答しない）。
  //   既定は notify（isNotifyMode()=true）。EBI_INJECT_MODE=pty で旧方式へロールバック可。
  // - id は先に予約しておき、worktree 有無に関わらず EBI_ID として pty env に注入する
  //   （子の stdio MCP が継承し、reply_to_master の from が自分の id になる）。
  const isClaude = command === "claude" || command.endsWith("/claude");
  const agentId = registry.reserveId(params.id);
  const roleMcpArgs =
    role && isClaude
      ? [
          "--mcp-config",
          ROLE_MCP_CONFIG[role.mcpRole],
          ...(isNotifyMode()
            ? ["--dangerously-load-development-channels", EBI_CONTROL_CHANNEL_SPEC]
            : []),
        ]
      : [];
  // EBI_ID は全 spawn 経路（master/supervisor/dynamic/engineer）で必ず注入する。
  // - engineer: 子の stdio MCP が継承し reply_to_master の from を自分の id にする。
  // - 全エビ共通: statusLine スクリプトがこの id で usage を /control/usage へ POST し、
  //   どのエビの cost/context かを識別できるようにする（ダッシュボード）。
  // command 種別に関わらず注入してよい（bash テストでも env 継承の確認ができる）。
  const launchEnv = { EBI_ID: agentId };

  // claude フラグ（model/permission-mode/append-system-prompt）を組み立てる。
  // bash 等の非 claude command 時は buildClaudeArgs 側でフラグを付けない。
  const claudeArgs = buildClaudeArgs({
    command,
    model,
    permissionMode,
    appendSystemPrompt,
    extraArgs: [...roleMcpArgs, ...spawnConfig.args],
  });

  // worktree なし: cwd 直指定で起動。
  if (!params.useWorktree) {
    const launch: LaunchParams = {
      command,
      args: claudeArgs,
      cwd,
      model,
      env: launchEnv,
    };
    const agent = registry.spawn(cwd, handlers, { id: agentId, kind: params.kind, role: role?.id, launch });
    broadcast({ type: "spawned", agent: agent.toRecord() });
    broadcastRegistry();
    return agent.id;
  }

  // worktree 有効。対象 repo は指定があればそれ、無ければ cwd。
  // agentId は冒頭で予約済み（EBI_ID 注入と既定ブランチ名サジェストに共用する）。
  const repoPath = params.repoPath && params.repoPath.trim() ? params.repoPath.trim() : cwd;
  const branch = params.branch && params.branch.trim() ? params.branch.trim() : `ebi/${agentId}`;

  const wt = await addWorktree(repoPath, branch);
  if (wt.reused) broadcast({ type: "notice", id: agentId, text: wt.reused });
  const launch: LaunchParams = {
    command,
    args: claudeArgs,
    cwd: wt.worktreePath,
    model,
    env: launchEnv,
  };
  const agent = registry.spawn(wt.worktreePath, handlers, {
    id: agentId,
    kind: params.kind,
    role: role?.id,
    launch,
    branch: wt.branch,
    worktreeRepo: wt.repoTop,
    worktreePath: wt.worktreePath,
  });
  broadcast({ type: "spawned", agent: agent.toRecord() });
  broadcastRegistry();
  return agent.id;
}

/** sendMessage の入力パラメータ。 */
export interface SendMessageParams {
  /** 送信先エビ id。 */
  to: string;
  /** 送る本文。 */
  message: string;
  /** 送信元タグ（既定 "user"）。 */
  from?: string;
  /** 送信先が存在しない場合に engineer として spawn するか（既定 false）。 */
  spawnIfMissing?: boolean;
  /** spawn 時のモデル（既定 opus）。 */
  model?: string | null;
  /** spawn 時の cwd。 */
  cwd?: string;
  /** spawn 時に worktree を切るか。 */
  useWorktree?: boolean;
  /** worktree の元 repo パス。 */
  repoPath?: string;
  /** worktree ブランチ名。 */
  branch?: string;
  /** spawnIfMissing で起動する際の役割（EBI_ROLES id。未指定は engineer）。 */
  role?: string;
  /** 【後方互換】spawnIfMissing で起動する際 engineer 役割にするか（既定 true 相当）。role が優先。 */
  asEngineer?: boolean;
}

/** sendMessage の結果。 */
export type SendMessageResult =
  | { ok: true; id: string; spawned: boolean; status: AgentStatus }
  | { ok: false; error: string; spawned: boolean };

/**
 * 統一メッセージ送信オーケストレーション。
 *
 * 「送信先セッションが立ち上がっているか／まだか」を自動判定して確実に届ける:
 *  1. 宛先が存在しない:
 *     - spawnIfMissing=false → { ok:false, error:"not found" }（notice も）
 *     - spawnIfMissing=true  → engineer として spawn（id は `to` を採用）→ spawned=true
 *  2. 対象が ready（入力受付）になるまで waitUntilReady(READY_WAIT_MS) で待つ。
 *     timeout したら { ok:false, error:"ready timeout" }（spawn 済みなら spawned=true で返す）。
 *  3. ready 後に agent.inject(from, message)（idle→即送信／busy→キューは既存ロジックに委ねる）。
 *
 * 「すでに立ち上がっている」= 1 をスキップし 2 が即 resolve → 3 で送信。
 * 「まだ」= 1 で spawn → 2 で ready 待ち → 3 で送信。分岐はこの関数内で完結する。
 */
async function sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
  const { to, message } = params;
  const from = params.from ?? "user";

  let spawned = false;
  let agent = registry.get(to);

  // ---- 1. 存在判定・必要なら spawn ----
  if (!agent) {
    if (!params.spawnIfMissing) {
      broadcast({ type: "notice", id: to, text: `送信先エビが見つかりません: ${to}（spawnIfMissing 未指定）` });
      return { ok: false, error: "not found", spawned: false };
    }
    // 役割付きで spawn（id は to を採用）。既定 role は engineer。
    // prompt / permissionMode / 既定モデルは spawnAgent 内で EBI_ROLES から適用される
    //（model 明示指定があればそちらが勝つ）。
    // 後方互換: asEngineer=false が明示されたときだけ役割なしの素の dynamic にする。
    const roleId = params.role ?? ((params.asEngineer ?? true) ? "engineer" : undefined);
    await spawnAgent({
      id: to,
      model: params.model ?? undefined,
      cwd: params.cwd,
      useWorktree: params.useWorktree,
      repoPath: params.repoPath,
      branch: params.branch,
      kind: "dynamic",
      role: roleId,
    });
    spawned = true;
    agent = registry.get(to);
    if (!agent) {
      // 通常起きないが、spawn 直後に消えた場合の保険。
      return { ok: false, error: "spawn したが agent を取得できません", spawned };
    }
  }

  // ---- 2. notification 経路（優先）----
  // mailbox 経由の配送が有効 かつ 対象が制御MCP ブリッジを持つ（claude + --mcp-config）なら、
  // 購読確立を最大 SUBSCRIBE_WAIT_MS 待ってから mailbox へ push する。
  // 通知方式は PTY の idle/busy 判定が原理上不要なため、確立さえすれば busy 中でも即届く。
  // 購読が確立しない（ブリッジ非搭載 or 起動に失敗）場合は待たず PTY 経路へフォールバックする。
  //
  // ただし notifySubscribe:false のエビ（外部チャンネル待機セッション minaebi 等・受信 PTY 固定）は
  // この経路に入らず PTY 注入へ直行する。自セッションに ebi-control channel を登録しないため
  // notification は harness に黙って捨てられる＝購読は永遠に確立せず、待つだけ無駄になるため。
  if (registry.notifyEnabled() && hasControlBridge(agent) && agent.notifySubscribe !== false) {
    const subscribed =
      registry.hasActiveSubscriber(to) || (await registry.waitForSubscriber(to, SUBSCRIBE_WAIT_MS));
    if (subscribed) {
      registry.deliver(to, from, message);
      return { ok: true, id: to, spawned, status: agent.getStatus() };
    }
    broadcast({
      type: "notice",
      id: to,
      text: `${to} の notification 購読が確立しませんでした（${SUBSCRIBE_WAIT_MS}ms）。PTY 注入にフォールバックします`,
    });
  }

  // ---- 3. ready（入力受付）まで待つ（PTY フォールバック経路）----
  const ready = await agent.waitUntilReady(READY_WAIT_MS);
  if (!ready) {
    broadcast({
      type: "notice",
      id: to,
      text: spawned
        ? `${to} を spawn しましたが ready 待ちがタイムアウトしました（${READY_WAIT_MS}ms）`
        : `${to} の ready 待ちがタイムアウトしました（${READY_WAIT_MS}ms）`,
    });
    return { ok: false, error: "ready timeout", spawned };
  }

  // ---- 4. 送信（idle→即送信／busy→キューは Agent.inject に委ねる）----
  agent.inject(from, message);
  return { ok: true, id: to, spawned, status: agent.getStatus() };
}

/**
 * 要約エンジンの共通呼び出し（WS / 制御API 共通）。
 * 対象エビの直近スクロールバックを 1 回だけワンショット要約エンジン
 * （`claude --print --model haiku`・サブスク課金）に渡す。全ログ常時送出はしない。
 * agent が無ければ理由を返す（呼び出し側で 404/notice に振り分ける）。
 */
async function summarizeAgent(
  id: string,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const agent = registry.get(id);
  if (!agent) return { ok: false, reason: `agent が見つかりません: ${id}` };
  return supervisor.summarize(agent.getScrollback());
}

/**
 * オンデマンド要約処理（WS 経由）。
 * claude が無い（supervisor 無効）ときは API を呼ばず notice を返す。
 * 成功時のみ `summary` を要求元の接続へ返す。失敗時は notice。
 */
async function handleSummarize(ws: WebSocket, id: string): Promise<void> {
  if (!supervisor.enabled) {
    send(ws, {
      type: "notice",
      id,
      text: "監督・要約は無効です（claude CLI が見つかりません）",
    });
    return;
  }
  if (!registry.has(id)) {
    send(ws, { type: "error", text: `agent が見つかりません: ${id}` });
    return;
  }
  const result = await summarizeAgent(id);
  if (result.ok) {
    send(ws, { type: "summary", id, text: result.text });
  } else {
    send(ws, { type: "notice", id, text: result.reason });
  }
}

/**
 * 固定エビ config を読み、自動起動する。
 * config が無ければ何もしない。読み込み/検証失敗時は警告のみで起動は継続する
 * （動的エビ運用は config 無しでも成立するため、サーバごと落とさない）。
 */
async function startFixedEbi(): Promise<void> {
  try {
    const specs = await loadFixedEbi(CONFIG_PATH, { command: COMMAND });
    if (specs.length === 0) {
      console.log(`[ebi-team] 固定エビ: なし（${CONFIG_PATH} 未配置または fixedEbi 空）`);
      return;
    }
    console.log(
      `[ebi-team] 固定エビを自動起動: ${specs.map((s) => `${s.id}(${s.kind})`).join(", ")}`,
    );
    fixedEbi.start(specs, handlers);
  } catch (err) {
    console.warn(`[ebi-team] 固定エビ config の読み込みに失敗（動的エビのみで継続）:`, err);
  }
}

/**
 * ebi-team.config.json の top-level "roles"（カスタム動的ロール）を読み、EBI_ROLES
 * レジストリへマージする。httpServer.listen() より前（＝ spawn 要求を一切受け付けられない
 * 段階）で完了させ、role 解決が常にマージ後のレジストリを見るようにする。
 * config が無い/roles 未指定なら何もしない。検証失敗時は警告のみで起動は継続する
 * （公開版の既定 engineer のみでも成立するため、サーバごと落とさない）。
 */
async function loadAndRegisterCustomRoles(): Promise<void> {
  try {
    const raw = await loadRawCustomRoles(CONFIG_PATH);
    registerCustomRoles(raw);
    const customIds = Object.keys(EBI_ROLES).filter((id) => id !== "engineer");
    if (customIds.length > 0) {
      console.log(`[ebi-team] カスタム役割を登録: ${customIds.join(", ")}`);
    }
  } catch (err) {
    console.warn(`[ebi-team] カスタム役割 config の読み込みに失敗（engineer のみで継続）:`, err);
  }
}

/**
 * ebi-team.config.json の top-level "devChannelsAllowlist" を読み、spawnConfig.devChannelsAllowlist
 * （組込み BASE_ALLOWED_DEV_CHANNELS で初期化済み）へ「追加」マージする。重複は無視する。
 * httpServer.listen()／固定エビ自動起動より前に完了させ、以降の spawn が常にマージ後の
 * 許可リストを見るようにする（Registry は spawnConfig 参照を保持する）。
 * config が無い/未指定なら何もしない。検証失敗時は警告のみで起動を継続する。
 */
async function loadAndApplyDevChannelsAllowlist(): Promise<void> {
  try {
    const extra = await loadDevChannelsAllowlist(CONFIG_PATH);
    for (const v of extra) {
      if (!spawnConfig.devChannelsAllowlist!.includes(v)) spawnConfig.devChannelsAllowlist!.push(v);
    }
    if (extra.length > 0) {
      console.log(
        `[ebi-team] 起動ゲート許可リスト（dev channels）: ${spawnConfig.devChannelsAllowlist!.join(", ")}`,
      );
    }
  } catch (err) {
    console.warn(`[ebi-team] devChannelsAllowlist の読み込みに失敗（組込みのみで継続）:`, err);
  }
}

// spawn 要求（WS / 制御API いずれも）を受け付ける前にカスタム役割・許可リストを確定させる。
await loadAndRegisterCustomRoles();
await loadAndApplyDevChannelsAllowlist();

// ===== 起動 / 終了処理 =====
httpServer.listen(PORT, HOST, () => {
  console.log(`[ebi-team] サーバ起動: http://${HOST}:${PORT}  (WS: ws://${HOST}:${PORT}/ws)`);
  if (loadedEnvKeys.length > 0) {
    // キー名のみ表示（値・トークンは出さない）。
    console.log(`[ebi-team] .env 読み込み: ${loadedEnvKeys.length}件 (${loadedEnvKeys.join(", ")})`);
  }
  console.log(`[ebi-team] 制御API: http://${HOST}:${PORT}/control/*  (loopback 無認証 / 非loopbackはトークン必須)`);
  if (authConfig.token) {
    console.log(`[ebi-team] 認証: EBI_AUTH_TOKEN 設定あり（非 loopback はトークン必須・/login で入力）`);
  } else if (HOST === "127.0.0.1" || HOST === "localhost") {
    console.log(`[ebi-team] 認証: 未設定（loopback 限定 bind のためローカル運用）`);
  } else {
    console.warn(
      `[ebi-team] 認証: EBI_AUTH_TOKEN 未設定のまま非 loopback に bind（${HOST}）。` +
        `非 loopback からのアクセスは全拒否されます。外部アクセスには EBI_AUTH_TOKEN を設定してください。`,
    );
  }
  console.log(`[ebi-team] spawn コマンド: ${COMMAND} ${COMMAND_ARGS.join(" ")}`.trim());
  console.log(`[ebi-team] デフォルト cwd: ${DEFAULT_CWD}`);
  console.log(`[ebi-team] idle しきい値: ${IDLE_THRESHOLD_MS}ms / registry ダンプ: ${DUMP_PATH}`);
  console.log(`[ebi-team] viewer 許可ルート: ${viewerRegistry.getRoots().join(", ")}`);
  // 監督機能の状態のみ表示。キー値は出さない。
  console.log(`[ebi-team] ${supervisor.describeStartup()}`);
  console.log(`[ebi-team] dev フロント: http://localhost:5173 （Vite）`);
  // 固定エビの自動起動（非同期・失敗してもサーバは継続）。
  void startFixedEbi();
});

function shutdown(): void {
  console.log("\n[ebi-team] 終了処理: 全 agent を kill します");
  // 固定エビの監視を先に止め、kill による exit で再起動が走らないようにする。
  fixedEbi.stop();
  registry.killAll();
  for (const ws of clients) ws.close();
  httpServer.close(() => process.exit(0));
  // close が詰まる場合の保険。
  setTimeout(() => process.exit(0), 1000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
