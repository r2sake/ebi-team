// .env をリポジトリルートから最初に読み込む（他 import が module-level で process.env を読む前に適用）。
import { loadedEnvKeys } from "./env.ts";
import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  Registry,
  hasControlBridge,
  isNotifyMode,
  supportsChannelInject,
  type DeliverOutcome,
  type WorktreeMeta,
} from "./registry.ts";
import { Mailbox } from "./mailbox.ts";
import { configureDeliveryLog, deliveryLogPath, logDelivery } from "./deliveryLog.ts";
import { buildAckFatalMessage, decideAckFailureAction } from "./ackRespawn.ts";
import type { Agent, SpawnConfig, AgentHandlers, LaunchParams } from "./agent.ts";
import {
  BASE_ALLOWED_DEV_CHANNELS,
  DEFAULT_BACKEND_ID,
  EBI_CONTROL_MCP_NAME,
  applyEnvDenyList,
  buildLaunchArgs,
  getBackend,
  initialInjectFor,
  resolveBackend,
  resolveBackendId,
  type BackendId,
  type BackendLaunchInput,
  type ControlMcpSpec,
} from "./backends/index.ts";
import { addWorktree, removeWorktree } from "./git.ts";
import { Supervisor } from "./supervisor.ts";
import {
  loadFixedEbi,
  supervisorEngineFrom,
  loadRawCustomRoles,
  loadDevChannelsAllowlist,
  loadBackendSettings,
  validatePermissionMode,
  DEFAULT_PERMISSION_MODE,
  EMPTY_BACKEND_SETTINGS,
  type BackendSettings,
  type FixedEbiSpec,
} from "./config.ts";
import { EBI_ROLES, resolveRole, registerCustomRoles, unknownRoleError } from "./roles.ts";
import { isRunningFromSrc, mcpConfigPathFor, type McpConfigRole } from "./mcpConfigPath.ts";
import { needsPreflight, runPreflight } from "./backendPreflight.ts";
import {
  FixedEbiManager,
  applyMasterBackendFailsafe,
  applyMasterMcpConfig,
  applyMasterUiOverride,
} from "./fixedEbi.ts";
import { MasterSession } from "./master/session.ts";
import { configureFixedEbiLog, fixedEbiLogPath, logFixedEbi } from "./fixedEbiLog.ts";
import { NoticeBuffer, DEFAULT_NOTICE_BUFFER_SIZE } from "./noticeBuffer.ts";
import { createControlApi, type GeneralizedSpawnParams } from "./control.ts";
import { UsageStore } from "./usageStore.ts";
import { configureUsageHistory, usageHistoryPath } from "./usageHistory.ts";
import { ContextGuard, contextGuardConfigFromEnv, type GuardNotice } from "./contextGuard.ts";
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
  type ChatHistoryMessage,
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
// config 由来のバックエンド既定（top-level "defaultBackend" / "backends"）。
// listen 前に loadAndApplyBackendSettings() が確定させる（それまでは「既定なし」）。
let backendSettings: BackendSettings = EMPTY_BACKEND_SETTINGS;
// サーバ既定のバックエンド id。優先度は spawn 引数 > 役割(EbiRole.backend) >
// config.defaultBackend > env EBI_BACKEND > "claude"。
// 未実装 id を指定されたら起動前に throw する（黙って claude に落とさない）。
let BACKEND_ID = resolveBackendId({ env: process.env.EBI_BACKEND });
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
// 配送イベントの恒久ログ（JSONL）。tty の console だけでは事後追跡できなかった反省から、
// フォールバック・二重購読・滞留・破棄をファイルにも残す。env EBI_DELIVERY_LOG_PATH で変更、
// "off" で無効化（console のみ）。
const DELIVERY_LOG_PATH =
  process.env.EBI_DELIVERY_LOG_PATH === "off"
    ? null
    : (process.env.EBI_DELIVERY_LOG_PATH ?? join(process.cwd(), ".ebi-team", "delivery.log"));
configureDeliveryLog(DELIVERY_LOG_PATH);
// 固定エビ（master/supervisor）のライフサイクル恒久ログ（JSONL）。spawn 失敗・短命死・
// crashloop 停止をここに残す（配送ログとは別系統。env EBI_FIXED_EBI_LOG_PATH で変更、"off" で無効）。
const FIXED_EBI_LOG_PATH =
  process.env.EBI_FIXED_EBI_LOG_PATH === "off"
    ? null
    : (process.env.EBI_FIXED_EBI_LOG_PATH ?? join(process.cwd(), ".ebi-team", "fixed-ebi.log"));
configureFixedEbiLog(FIXED_EBI_LOG_PATH);
// レート制限使用率（rate_limits）の恒久ログ（JSONL）。statusLine が運んでくる five_hour /
// seven_day の used_percentage を、値が変わったときだけ追記する（in-memory の latest しか
// 持っておらず「先週どれだけ枠を使ったか」を後から追えなかった反省から）。
// env EBI_USAGE_HISTORY_PATH で変更、"off" で無効化。
const USAGE_HISTORY_PATH =
  process.env.EBI_USAGE_HISTORY_PATH === "off"
    ? null
    : (process.env.EBI_USAGE_HISTORY_PATH ?? join(process.cwd(), ".ebi-team", "usage-history.jsonl"));
configureUsageHistory(USAGE_HISTORY_PATH);
// master チャット（ui:"chat"）の会話 JSONL。再接続・サーバ再起動後の snapshot 復元に使う。
// env EBI_MASTER_CHAT_LOG_PATH で変更、"off" で無効化（メモリのみ）。
const MASTER_CHAT_LOG_PATH =
  process.env.EBI_MASTER_CHAT_LOG_PATH === "off"
    ? null
    : (process.env.EBI_MASTER_CHAT_LOG_PATH ??
      join(process.cwd(), ".ebi-team", "master-chat.jsonl"));
// 再アタッチ用スクロールバックのリングバッファ上限（バイト相当・既定 1MB）。
// インライン TUI 化（agent.ts の INLINE_TUI_ENV）以降、ここには代替スクリーンの再描画ノイズでは
// なく「実ログ」が積まれるため、リロード後に十分遡れるよう既定を広げている。
const SCROLLBACK_BYTES = Number(process.env.EBI_SCROLLBACK_BYTES ?? 1024 * 1024);
// 固定エビ config のパス（無ければ固定エビ機能 OFF）。
const CONFIG_PATH = process.env.EBI_CONFIG_PATH ?? join(process.cwd(), "ebi-team.config.json");
// 役割別 MCP config（reply_to_master 等の最小権限）のパス。
// dev（tsx 実行・src 起点）か本番（dist 起点）かを __dirname で判定して既定を選ぶ。
// env EBI_ENGINEER_MCP_CONFIG で明示上書き可（テスト/特殊配置用）。
// ファイル名規約（dev: <role>-control.dev.mcp.json / 本番: <role>-control.mcp.json）は
// 生成側スクリプトと共有するため mcpConfigPath.ts に切り出してある。
const RUNNING_FROM_SRC = isRunningFromSrc(__dirname);
function defaultMcpConfigPath(mcpRole: McpConfigRole): string {
  return mcpConfigPathFor(mcpRole, { fromSrc: RUNNING_FROM_SRC, baseDir: process.cwd() });
}
// master 分も同じ仕組みで持つ（2026-08-12: master だけ config 手書きだったため npm start で
// 存在しない .dev パスを指し、claude が起動即死 → crashloop 停止していた。fixedEbi.ts の
// applyMasterMcpConfig が spawn 時にこの値を付与する）。
const ROLE_MCP_CONFIG: Record<McpConfigRole, string> = {
  engineer: process.env.EBI_ENGINEER_MCP_CONFIG ?? defaultMcpConfigPath("engineer"),
  master: process.env.EBI_MASTER_MCP_CONFIG ?? defaultMcpConfigPath("master"),
};
// --dangerously-load-development-channels に渡す channel 指定子は backends/claude.ts が持つ
// （EBI_CONTROL_CHANNEL_SPEC）。付与条件も含めてバックエンド実装に閉じている。

/**
 * backend 別の追加起動引数。EBI_ARGS は claude 向けの設定なので非 claude には渡さず、
 * `EBI_CODEX_ARGS` を使う（フラグ体系が違うため取り違えると即起動失敗になる）。
 */
/** 空文字を「未指定」として扱う（config / 役割の defaultModel は空文字を許容するため）。 */
function nonEmpty(v: string | null | undefined): string | null {
  return v != null && v !== "" ? v : null;
}

function extraArgsForBackend(id: BackendId): string[] {
  if (id === DEFAULT_BACKEND_ID) return [...spawnConfig.args];
  const raw = process.env[`EBI_${id.toUpperCase()}_ARGS`];
  return raw ? raw.split(" ").filter((a) => a.length > 0) : [];
}

/**
 * 制御MCP（ebi-control）の中立表現。設定ファイルではなく**起動引数に焼く** backend
 * （codex の `-c mcp_servers.*`）が使う。生成規約は scripts/gen-master-mcp.mjs と同じ
 * （dev = tsx で src、本番 = node で dist）。
 * EBI_ID をここで焼くのは、codex では pty env 継承だけに頼れないため（PoC の起動形も同じ）。
 */
function controlMcpSpecFor(mcpRole: McpConfigRole, agentId: string): ControlMcpSpec {
  const root = process.cwd();
  // dev（src 起点）でも `npx tsx` ではなく **同じ node バイナリ ＋ tsx ローダ**で起動する。
  // npx は解決に数秒かかり、codex の MCP 起動待ちに間に合わずツールが使えないまま
  // セッションが始まる（= reply_to_master が飛ばない静かな故障。PR-D の e2e で実測）。
  const server = RUNNING_FROM_SRC
    ? {
        command: process.execPath,
        args: ["--import", "tsx", join(root, "src/mcp/control-server.ts")],
      }
    : { command: "node", args: [join(root, "dist/server/mcp/control-server.js")] };
  return {
    name: EBI_CONTROL_MCP_NAME,
    command: server.command,
    args: server.args,
    cwd: root,
    env: {
      EBI_CONTROL_URL: `http://${HOST}:${PORT}`,
      EBI_MCP_ROLE: mcpRole,
      EBI_ID: agentId,
      // channel 注入非対応の backend は PTY 注入で受けるため、購読ループは回さない。
      EBI_NOTIFY_SUBSCRIBE: "off",
    },
  };
}

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
//
// liveness window（配送ゲート判定）は「ブリッジの long-poll timeout ＋ 再接続の余裕」を満たす
// 必要がある。ブリッジ側 EBI_SUBSCRIBE_TIMEOUT_MS（既定 25s）を上げた場合はこちらも
// EBI_LIVENESS_WINDOW_MS で合わせて上げること（下回るとライブなブリッジを誤って dead 判定する）。
const LIVENESS_WINDOW_MS =
  Number(process.env.EBI_LIVENESS_WINDOW_MS) || Mailbox.DEFAULT_LIVENESS_WINDOW_MS;
// 購読所有権の失効時間（ms）。所有者の long-poll がこの時間 1 度も張り直されなければ、
// 別トークンの購読者が引き継げる（正当な再接続の救済。既定 30s < long-poll 25s の 2 周期）。
const SUBSCRIBER_TAKEOVER_MS =
  Number(process.env.EBI_SUBSCRIBER_TAKEOVER_MS) || Mailbox.DEFAULT_SUBSCRIBER_TAKEOVER_MS;
const mailbox = new Mailbox(LIVENESS_WINDOW_MS, SUBSCRIBER_TAKEOVER_MS);

const registry = new Registry(spawnConfig, DUMP_PATH, mailbox);

// 固定エビ（master/supervisor）の自動起動・自動再起動マネージャ。
// config が無ければ start() に空配列が渡るだけで何も起きない。
const fixedEbi = new FixedEbiManager(registry);

// 監督・要約（既定 OFF）。OFF / キー無しなら enabled=false で API は一切呼ばない。
// 監督・要約エンジン（ワンショット）。既定は claude/haiku。
// config の supervisor 固定エビが backend=gemini なら、起動直前に同じ backend/model へ差し替える
// （loadAndApplySupervisorEngine）。let なのはその 1 点のためだけ。
let supervisor = new Supervisor();

// 使用状況（usage）ストア。各エビの statusLine が /control/usage に POST してくる
// cost/context/model と、アカウント単位の rate_limits を最新値で保持する。
const usageStore = new UsageStore();

// viewer（読み取り専用の md/txt プレビュー）コレクション。master の open_viewer で開き、
// クライアントは registry サイドバーに合成行として出す。プロセスは持たない。
// viewers.json（open 中の viewer の永続化先）。再起動後に同じタブを復元するために使う。
const VIEWERS_PATH = process.env.EBI_VIEWERS_PATH ?? join(process.cwd(), ".ebi-team", "viewers.json");
const viewerRegistry = new ViewerRegistry({ storePath: VIEWERS_PATH });

// ===== 接続中の WebSocket クライアント集合 =====
const clients = new Set<WebSocket>();

// broadcast した notice の直近履歴。新規接続時に replay して「開いた時には消えている」を防ぐ
// （固定エビの再起動 / crashloop 停止通知は起動から十数秒で流れ終わるため）。
// EBI_NOTICE_BUFFER_SIZE=0 で無効化できる。
const NOTICE_BUFFER_SIZE = Number(
  process.env.EBI_NOTICE_BUFFER_SIZE ?? DEFAULT_NOTICE_BUFFER_SIZE,
);
const noticeBuffer = new NoticeBuffer(
  Number.isFinite(NOTICE_BUFFER_SIZE) ? NOTICE_BUFFER_SIZE : DEFAULT_NOTICE_BUFFER_SIZE,
);

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
  // notice は直近分をリングバッファに残す（接続前に流れた通知を新規接続へ replay するため）。
  if (msg.type === "notice") noticeBuffer.push(msg.id, msg.text);
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

// ===== コンテキスト枯渇ガード（context-guard）=====
// master のコンテキスト使用率を監視し、自動 compact に食われて PM 文脈が消える前に「促す」。
// **compact も /clear もサーバは実行しない**（既存方針どおり促すだけ）。設計は
// docs/plans/context-guard-plan.md。判定本体は contextGuard.ts の純粋ステートマシン。
const contextGuardConfig = contextGuardConfigFromEnv();
const contextGuard = new ContextGuard(contextGuardConfig, (n) => onContextGuardNotice(n));

/**
 * ガードの発火を 2 経路へ流す（ボス裁定 X-2）:
 *  - ebi-team UI の notice（NoticeBuffer に載るので、通知時にブラウザを開いていなくても replay される）
 *  - master セッションへの inject（master は notifySubscribe:false ＝ PTY 注入固定で最も堅い）
 * 発火履歴はデバッグ用に info ログへ残す。
 */
function onContextGuardNotice(n: GuardNotice): void {
  console.info(
    `[context-guard] fire kind=${n.kind} level=${n.level} pct=${n.usedPct ?? "null"} ` +
      `quiescent=${n.quiescent} busyDynamic=${n.busyDynamic} target=${contextGuardConfig.targetId}`,
  );
  broadcast({ type: "notice", id: "context-guard", text: n.text });
  // 到達確認（ACK 待ち）を含むため async。促すだけの通知なので投げっぱなしにする。
  void registry
    .reverseInject("context-guard", contextGuardConfig.targetId, n.text, "reply")
    .then((result) => {
      if (result.delivered.length === 0 && result.rejected.length > 0) {
        console.warn(
          `[context-guard] ${contextGuardConfig.targetId} への通知を配信できませんでした: ` +
            `${result.rejected[0]?.reason}（UI notice には出ています）`,
        );
      }
    })
    .catch((err) => {
      console.warn("[context-guard] 通知の配信中にエラー:", err);
    });
}

/** usage 取り込みのたびに呼ぶ。監視対象の最新 usage だけをガードへ渡す。 */
function observeContextGuard(ebiId: string): void {
  if (!contextGuardConfig.enabled) return;
  if (ebiId !== contextGuardConfig.targetId) return;
  const target = usageStore.snapshot().agents.find((a) => a.id === contextGuardConfig.targetId);
  if (!target) return;
  try {
    contextGuard.observe(target, registry.list());
  } catch (err) {
    // 監視の失敗で usage 取り込み自体を壊さない（best-effort）。
    console.warn("[context-guard] 判定中にエラー:", err);
  }
}

// ===== master チャット（ui:"chat"）=====
// ui:"chat" の master は PTY を一切起動せず、MasterBrain（ヘッドレス CLI）を抱えた
// MasterSession で動く。ui 未指定/terminal のときはこの変数が null のままで、
// 既存の PTY 経路と**完全に同一**の外形になる（設計書 §6.1）。
let masterSession: MasterSession | null = null;

/** MasterSession を作って起動し、registry へ chat 配送先として登録する。 */
async function startMasterChatSession(spec: FixedEbiSpec): Promise<void> {
  // config の args に --mcp-config を手書きしている場合はそちらを尊重する
  //（applyMasterMcpConfig と同じ方針。二重指定を作らない）。
  const hasManualMcp = spec.extraArgs.includes("--mcp-config");
  const session = new MasterSession({
    id: spec.id,
    brainId: spec.brain,
    cwd: spec.launch.cwd,
    model: spec.launch.model,
    permissionMode: spec.permissionMode,
    systemPrompt: spec.launch.systemPrompt ?? null,
    mcpConfigPath: hasManualMcp ? null : ROLE_MCP_CONFIG.master,
    extraArgs: spec.extraArgs,
    logPath: MASTER_CHAT_LOG_PATH,
    handlers: {
      onEvent: (id, envelope) => {
        broadcast({ type: "chatEvent", id, seq: envelope.seq, ts: envelope.ts, event: envelope.event });
      },
      onState: (id, state, pending) => {
        broadcast({ type: "chatState", id, state, pending });
        // registry の status（idle/busy）にも写るので一覧を更新する。
        broadcastRegistry();
      },
      onNotice: (id, text) => broadcast({ type: "notice", id, text }),
      onUsage: (id, usage) => {
        // statusLine の代替。UsageStore を経由して WS usage と contextGuard に載せる。
        usageStore.updateFromChat(id, usage);
        broadcastUsage();
        observeContextGuard(id);
      },
      onRateLimits: (id, limits) => {
        usageStore.updateRateLimits(id, limits);
        broadcastUsage();
      },
      onRegistryChange: () => broadcastRegistry(),
    },
  });
  masterSession = session;
  registry.setChatTarget(spec.id, {
    record: () => session.record(),
    deliver: (input) => session.deliverFromEbi(input),
  });
  broadcastRegistry();
  logFixedEbi({
    event: "master-chat-start",
    level: "info",
    msg:
      `起動: ${spec.id} (master/chat) brain=${spec.brain} model=${spec.launch.model ?? "-"} ` +
      `cwd=${spec.launch.cwd}`,
    id: spec.id,
    kind: spec.kind,
    brain: spec.brain,
    cwd: spec.launch.cwd,
    args: spec.extraArgs,
  });
  await session.start();
}

/** 接続直後の chat 復元（state ＋ 直近の会話）。chat master が居ないときは何もしない。 */
function sendChatSnapshot(ws: WebSocket): void {
  const session = masterSession;
  if (!session) return;
  send(ws, { type: "chatState", id: session.id, state: session.state, pending: session.pendingCount });
  const snap = session.snapshot();
  send(ws, { type: "chatSnapshot", id: session.id, events: snap.events, hasMore: snap.hasMore });
}

/** chat 系 WS メッセージの宛先解決。id 違い/未起動は error を返して null。 */
function chatSessionFor(ws: WebSocket, id: string): MasterSession | null {
  const session = masterSession;
  if (!session || session.id !== id) {
    send(ws, { type: "error", text: `チャット対象の master が見つかりません: ${id}` });
    return null;
  }
  return session;
}

/** `chatHistory`（過去ログのページング）。 */
function handleChatHistory(ws: WebSocket, msg: ChatHistoryMessage): void {
  const session = chatSessionFor(ws, msg.id);
  if (!session) return;
  const snap = session.snapshot({
    ...(msg.before === undefined ? {} : { before: msg.before }),
    ...(msg.limit === undefined ? {} : { limit: msg.limit }),
  });
  send(ws, { type: "chatSnapshot", id: session.id, events: snap.events, hasMore: snap.hasMore });
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
    // 静かな故障の作り直し用に控えた spawn 引数も破棄する（作り直し経路は remove の前に
    // 自分で取り出して delete 済みなので、ここで消えるのは通常終了ぶんだけ）。
    ackRespawnParams.delete(id);
    broadcast({ type: "exited", id, exitCode });
    broadcastRegistry();
    if (meta) void cleanupWorktree(id, meta);
    // 固定エビなら自動再起動を予約する（crashloop 時はマネージャ側で停止）。
    if (managed) fixedEbi.onExit(id, handlers);
  },
  onNotice(id, text) {
    broadcast({ type: "notice", id, text });
  },
  onAckFailure(id, reason) {
    // 役割プロンプト ACK の「静かな故障」検知（codex）。kill →同一 id・同一引数で 1 回だけ
    // 作り直す。投げっぱなし（spawn の応答を待たせない）にするが、例外は握り潰さない。
    void handleAckFailure(id, reason).catch((err) => {
      console.error(`[ebi-team] [${id}] 静かな故障の再 spawn 処理で例外:`, err);
      broadcast({
        type: "notice",
        id,
        text: `${id} の作り直しに失敗しました: ${(err as Error).message}`,
      });
    });
  },
  onIdleNotify(id) {
    // [B] idle 自動通知（保険）。busy→idle のエッジで、master/supervisor 以外かつ
    // ready 済みのエビが「直近に A の明示リプライ無し・クールダウン超過」のとき Agent から
    // 呼ばれる。本文抽出はせず「待機に入った／read_scrollback で確認可」の軽い通知だけ送る。
    // reverseInject は到達確認（ACK 待ち）を含むため async。保険通知なので投げっぱなしにする。
    void registry
      .reverseInject(
        id,
        "master",
        "待機に入りました。詳細は read_scrollback で確認できます。",
        "idle",
      )
      .then((result) => {
        if (result.delivered.length === 0 && result.rejected.length > 0) {
          // master が居ない等で配信不能でも致命ではない（保険の通知なので notice のみ）。
          console.warn(`[ebi-team] idle 自動通知の配信不可（${id}）: ${result.rejected[0]?.reason}`);
        }
      });
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
    // コンテキスト枯渇ガード（監視対象は既定 master）。判定は同期・通知は onNotice 経由。
    observeContextGuard(ebiId);
  },
  // 各エビの制御MCP ブリッジが自分宛メッセージを long-poll 購読するための経路。
  // 初回購読の確立はサーバログに出す（notification 経路が生きているかの観測点）。
  subscribe: async (id, timeoutMs, opts) => {
    // 二重購読（同一 id を別プロセスが名乗る）をここで検出・拒否する。
    // 旧実装は互いを蹴り出し合い、push の瞬間に座っていた方へ coin flip で配送していた
    // （幽霊プロセスが master 宛の約半分を横取りした実障害の直接原因）。
    const claim = mailbox.claimSubscriber(id, opts?.token);
    if (!claim.ok) {
      logDelivery({
        event: "duplicate-subscriber",
        msg:
          `id=${id} への二重購読を拒否（先着 token=${claim.holder.token} が保持中・` +
          `拒否 ${claim.holder.rejected} 回目）。同じ EBI_ID を名乗る別プロセスが居ないか確認すること`,
        id,
        rejectedToken: opts?.token ?? null,
        holder: claim.holder,
      });
      return { rejected: { reason: claim.reason, holder: claim.holder } };
    }
    if (claim.mode === "claimed") {
      console.log(`[ebi-team] notification 購読が確立: id=${id} token=${opts?.token ?? "(未提示)"}`);
    } else if (claim.mode === "takeover") {
      logDelivery({
        event: "subscriber-takeover",
        level: "info",
        msg:
          `id=${id} の購読を引き継ぎ（旧 token=${claim.previousToken} が ` +
          `${SUBSCRIBER_TAKEOVER_MS}ms 無音 → 新 token=${opts?.token}）`,
        id,
        previousToken: claim.previousToken ?? null,
        token: opts?.token ?? null,
      });
    } else if (claim.mode === "untracked" && !mailbox.everSubscribed(id)) {
      console.log(`[ebi-team] notification 購読が確立: id=${id}（token 未提示・二重購読検出は無効）`);
    }
    const messages = await mailbox.subscribe(id, timeoutMs, opts);
    return { messages };
  },
  // master の open_viewer からの viewer 追加。登録後に viewers を broadcast する。
  openViewer: async (path, title) => {
    const rec = await viewerRegistry.open({ path, title });
    broadcastViewers();
    return rec;
  },
  // 画像 viewer のバイナリ配信（クライアントの <img src="/control/viewer-file?id=..."> が叩く）。
  readViewerFile: (id) => viewerRegistry.readImage(id),
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
  // master が ui:"chat" なら、状態と直近の会話も送る（再接続で会話が欠けないようにする）。
  sendChatSnapshot(ws);
  // 接続前に broadcast された notice を古い順に replay する（replay:true・当時の ts 付き）。
  // 起動直後に固定エビが crashloop 停止しても、後からブラウザを開いた人が気づけるようにする。
  for (const n of noticeBuffer.list()) {
    send(ws, { type: "notice", id: n.id, text: n.text, ts: n.ts, replay: true });
  }

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
    case "chatSend": {
      const session = chatSessionFor(ws, msg.id);
      if (!session) break;
      void session.sendUserText(msg.text).then((r) => {
        if (!r.accepted) send(ws, { type: "error", text: r.reason ?? "送信できませんでした" });
      });
      break;
    }
    case "chatStop": {
      const session = chatSessionFor(ws, msg.id);
      if (!session) break;
      void session.interrupt().catch((err) => {
        send(ws, { type: "error", text: `中断に失敗しました: ${(err as Error).message}` });
      });
      break;
    }
    case "chatAnswer": {
      const session = chatSessionFor(ws, msg.id);
      if (!session) break;
      void session
        .answer(msg.requestId, {
          ...(msg.allow === undefined ? {} : { allow: msg.allow }),
          ...(msg.choice === undefined ? {} : { choice: msg.choice }),
          ...(msg.text === undefined ? {} : { text: msg.text }),
        })
        .catch((err) => {
          send(ws, { type: "error", text: `応答の送信に失敗しました: ${(err as Error).message}` });
        });
      break;
    }
    case "chatHistory": {
      handleChatHistory(ws, msg);
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
    await spawnAgent({
      id: msg.id,
      cwd: msg.cwd,
      useWorktree: msg.useWorktree,
      repoPath: msg.repoPath,
      branch: msg.branch,
      // UI ヘッダの backend セレクトからの指定（未指定なら役割/config/env の既定）。
      backend: msg.backend,
    });
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

  // 役割（EBI_ROLES）を解決する。後方互換: asEngineer=true は role="engineer" と等価。
  // 未知の role 文字列は 400 相当のエラーにする（黙って素の dynamic にしない）。
  const roleId = params.role ?? (params.asEngineer ? "engineer" : undefined);
  const role = resolveRole(roleId);
  if (roleId && !role) {
    // 許容ロールは EBI_ROLES のキーから動的に生成する（カスタム役割を足せば自動で反映される）。
    // メッセージ生成は roles.ts の unknownRoleError が SoT（MCP ブリッジ側の
    // 説明文と同じ一覧を使う＝呼び出し側が役割名を推測しなくて済む）。
    throw unknownRoleError(roleId);
  }

  // 適用優先度: 明示指定 > 役割既定 > サーバ既定。
  const permissionMode = params.permissionMode
    ? validatePermissionMode(params.permissionMode)
    : (role?.permissionMode ?? DEFAULT_PERMISSION_MODE);
  const appendSystemPrompt = params.appendSystemPrompt ?? role?.appendSystemPrompt ?? null;

  // バックエンド解決: spawn 引数 > 役割既定（EbiRole.backend）> config.defaultBackend >
  // env EBI_BACKEND > claude（PR-E）。
  // 実装済みでない backend を明示指定された場合はここで throw し、制御API が
  // 400 相当のエラーで返す（黙って claude に落とさない）。
  const backendId = resolveBackendId({
    explicit: params.backend,
    role: role?.backend,
    configDefault: backendSettings.defaultBackend,
    env: process.env.EBI_BACKEND,
  });
  const backend = getBackend(backendId);

  // モデル名の語彙は backend ごとに別物（claude の "opus"/"sonnet" は codex では通らず、
  // ChatGPT アカウントでは `The 'sonnet' model is not supported` で毎ターン 400 になる）。
  // よって役割の defaultModel（claude 語彙）は claude にだけ効かせ、非 claude では
  //   明示指定 > EBI_<ID>_MODEL > 未指定（CLI 既定モデル）
  // の順で解決する（PR-D）。
  // 役割の defaultModel は「役割の既定 backend で起動したとき」だけ効かせる（PR-E）。
  // 役割 backend 未指定の役割は claude 語彙とみなす（従来どおり）。
  const roleBackendId = role?.backend ?? DEFAULT_BACKEND_ID;
  const roleModel = role && roleBackendId === backendId ? nonEmpty(role.defaultModel) : null;
  const model =
    params.model ??
    roleModel ??
    nonEmpty(backendSettings.backends[backendId]?.defaultModel) ??
    (backendId === DEFAULT_BACKEND_ID
      ? null
      : (process.env[`EBI_${backendId.toUpperCase()}_MODEL`] ?? null));

  // 起動バイナリの解決。サーバ既定 command（EBI_COMMAND / 既定 "claude"）がその backend の
  // ものでなければ backend の既定バイナリを使う（claude サーバから gemini/codex エビを起動する経路）。
  // ただし **どの backend にも一致しない command（EBI_COMMAND=bash 等のスタブ起動）は
  // そのまま尊重する**（テスト用の逃げ道を潰さないため。従来挙動と同一）。
  const serverBackend = resolveBackend(spawnConfig.command);
  const command =
    serverBackend === null || serverBackend.id === backendId
      ? spawnConfig.command
      : (backendSettings.backends[backendId]?.command ?? backend.defaultCommand);

  // 役割付きなら ebi-control MCP（最小権限・reply_to_master 等）を追加する。
  // 「どのフラグをどう付けるか」はバックエンド実装（backends/claude.ts の buildArgs）に閉じており、
  // ここでは抽象パラメータ（mcpConfigPath / notifyMode）を渡すだけにする。
  // - 非対応 command（EBI_COMMAND=bash 等のスタブ起動）では buildLaunchArgs が固有フラグを
  //   一切付けない（bash が解釈できず即終了→crashloop になるのを防ぐ、従来からの方針）。
  // - notify モードが有効なときだけ dev-channels フラグが付き、ebi-control MCP がセッションの
  //   channel として register される。これが無いと notification 注入が成立しない
  //   （2026-07-11 harness バイナリ解析＋実機検証で確定。capability 宣言は control-server.ts 側）。
  //   このフラグを付けた claude は起動時に development channels 警告ダイアログを出すが、
  //   agent.ts の起動ゲート自動応答（maybeAnswerStartupGates）が "1"+Enter で越える
  //   （運用者承認のもと有効化・live e2e 19/20 OK）。安全限定＝dev-channels 値が
  //   server:ebi-control ちょうど1個のときのみ自動応答（別サーバ名・複数指定は応答しない）。
  //   既定は notify（isNotifyMode()=true）。EBI_INJECT_MODE=pty で旧方式へロールバック可。
  // - id は先に予約しておき、worktree 有無に関わらず EBI_ID として pty env に注入する
  //   （子の stdio MCP が継承し、reply_to_master の from が自分の id になる）。
  const agentId = registry.reserveId(params.id);
  // EBI_ID は全 spawn 経路（master/supervisor/dynamic/engineer）で必ず注入する。
  // - engineer: 子の stdio MCP が継承し reply_to_master の from を自分の id にする。
  // - 全エビ共通: statusLine スクリプトがこの id で usage を /control/usage へ POST し、
  //   どのエビの cost/context かを識別できるようにする（ダッシュボード）。
  // command 種別に関わらず注入してよい（bash テストでも env 継承の確認ができる）。
  const launchEnv = { EBI_ID: agentId };

  // バックエンド固有の起動引数を組み立てる（claude なら
  // --model / --permission-mode / --append-system-prompt / --mcp-config / dev-channels）。
  const mcpConfigPath = role ? ROLE_MCP_CONFIG[role.mcpRole] : null;
  // 制御MCP の渡し方は backend の方言で異なる（claude=JSON ファイルパス / gemini=env /
  // codex=`-c` に焼く）。どれを使うかは backend 実装が決めるので、ここでは全部渡す。
  const launchInputFor = (trustPaths: readonly string[]): BackendLaunchInput => ({
    model,
    permissionMode,
    systemPrompt: appendSystemPrompt,
    mcpConfigPath,
    controlMcp: role ? controlMcpSpecFor(role.mcpRole, agentId) : null,
    // フォルダ信頼ゲートを出させないために宣言するディレクトリ（codex のみ使用）。
    trustPaths,
    notifyMode: isNotifyMode(),
    extraArgs: extraArgsForBackend(backendId),
  });

  // 起動前チェック（認証ファイル / 必須 env / CLI バージョン）。
  // 確認すべきことを 1 つも持たない backend（claude）では実行されない＝外形ゼロ差分。
  // errors があれば spawn を止めて明示エラーにする（起動即死 → crashloop より原因が分かる）。
  if (needsPreflight(backend)) {
    const pf = await runPreflight(backend, {
      command,
      env: applyEnvDenyList(process.env, backend.envDenyList),
    });
    for (const w of pf.warnings) {
      console.warn(`[preflight:${backendId}] 警告: ${w}`);
    }
    if (!pf.ok) {
      throw new Error(
        `backend "${backendId}" の起動前チェックに失敗しました: ${pf.errors.join(" / ")}`,
      );
    }
  }

  // worktree なし: cwd 直指定で起動。
  if (!params.useWorktree) {
    const input = launchInputFor([cwd]);
    const launch: LaunchParams = {
      command,
      args: buildLaunchArgs(command, input),
      cwd,
      model,
      env: launchEnv,
      backend: backendId,
      mcpConfigPath,
      systemPrompt: appendSystemPrompt,
      // 役割プロンプトを起動引数で渡せない backend（codex）は ready 後に PTY 注入する。
      initialInject: initialInjectFor(command, input),
      // 役割別の ACK 監視窓（imagegen のように 1 ターンが長い役割で誤 respawn を避ける）。
      ackWatchMs: role?.ackWatchMs ?? null,
    };
    const agent = registry.spawn(cwd, handlers, { id: agentId, kind: params.kind, role: role?.id, launch });
    watchEarlyExit(agent, backend, params);
    watchAckFailure(agent, backend, params);
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
  // worktree は git のサブディレクトリ扱いなので、repo root と worktree の**両方**を
  // 信頼済みとして宣言する（codex のフォルダ信頼ゲート対策・PoC §3.1）。
  const input = launchInputFor([wt.repoTop, wt.worktreePath]);
  const launch: LaunchParams = {
    command,
    args: buildLaunchArgs(command, input),
    cwd: wt.worktreePath,
    model,
    env: launchEnv,
    backend: backendId,
    mcpConfigPath,
    systemPrompt: appendSystemPrompt,
    initialInject: initialInjectFor(command, input),
    ackWatchMs: role?.ackWatchMs ?? null,
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
  watchEarlyExit(agent, backend, params);
  watchAckFailure(agent, backend, params);
  broadcast({ type: "spawned", agent: agent.toRecord() });
  broadcastRegistry();
  return agent.id;
}

/**
 * 役割プロンプト ACK の「静かな故障」検知で作り直すために、spawn 引数を控えておく。
 *
 * 背景（docs/backends/codex.md §7.1）: codex エビは一定確率で、役割プロンプトへの ACK に
 * 「reply_to_master ツールが利用できない」と書き、以後タスクを実行しない。プロセスは生きて
 * idle に戻るため、master からは「起動して落ち着いているが報告が来ない」ようにしか見えず、
 * タスクが 1 件静かに消える。検知（agent.ts の maybeDetectAckFailure）と、その後の
 * 「kill →同一 id・同一引数で 1 回だけ再 spawn」をここで繋ぐ。
 *
 * ackFailureWatch を持たない backend（claude / gemini）では何も登録しない＝挙動不変。
 */
const ackRespawnParams = new Map<string, GeneralizedSpawnParams>();

/** 作り直し時に旧プロセスの exit を待つ上限(ms)。プロセスグループ kill の猶予より長く取る。 */
const ACK_RESPAWN_EXIT_WAIT_MS = Number(process.env.EBI_ACK_RESPAWN_EXIT_WAIT_MS) || 8000;

function watchAckFailure(
  agent: Agent,
  backend: ReturnType<typeof getBackend>,
  params: GeneralizedSpawnParams,
): void {
  if (!backend.ackFailureWatch) return;
  ackRespawnParams.set(agent.id, params);
}

/**
 * 「静かな故障」を検知したエビを 1 回だけ作り直す。
 *
 * - 1 回目: kill（プロセスグループ）→ 同一 id・同一引数で再 spawn。旧エビの注入キューに
 *   滞留していた本文（master が送ったタスク）は新エビへ引き継ぐ（捨てると「作り直したが
 *   タスクは消えた」という、直そうとしている故障そのものになる）。
 * - 2 回目: 作り直さず **fatal として master へ通知**する（reverseInject＝既存の通知経路）。
 *   黙って idle のまま放置するのが一番困るため、報告は必ず出す。
 */
async function handleAckFailure(id: string, reason: string): Promise<void> {
  const params = ackRespawnParams.get(id);
  const agent = registry.get(id);
  const action = decideAckFailureAction({
    hasParams: params !== undefined,
    agentAlive: agent !== undefined,
    isRetry: params?.retryOfAckFailure === true,
  });
  ackRespawnParams.delete(id);
  if (action === "ignore" || params === undefined || agent === undefined) return;
  const backendId = agent.backend;

  if (action === "fatal") {
    const text = buildAckFatalMessage(id, backendId, reason);
    logDelivery({
      event: "ack-failure-fatal",
      level: "warn",
      msg: `${id} が再 spawn 後も静かな故障（${reason}）。master へ fatal 通知`,
      id,
      backend: backendId,
      reason,
      attempt: 2,
    });
    broadcast({ type: "notice", id, text });
    const r = await registry.reverseInject(id, "master", text, "reply");
    if (r.delivered.length === 0) {
      console.error(`[ebi-team] [${id}] fatal 通知を master へ配信できませんでした`);
    }
    return;
  }

  logDelivery({
    event: "ack-failure-respawn",
    level: "warn",
    msg: `${id} の役割プロンプト ACK で静かな故障（${reason}）。kill して 1 回だけ再 spawn する`,
    id,
    backend: backendId,
    reason,
    attempt: 1,
  });
  broadcast({
    type: "notice",
    id,
    text: `${id}（backend=${backendId}）が「${reason}」。kill して 1 回だけ作り直します`,
  });

  // 作り直しで引き継ぐ本文（master のタスク）を先に取り出してから kill する。
  // ready 直後のエビは idle なので、タスクは**注入キューを経ずに PTY へ直接書かれる**。
  // よってキューの中身だけでは足りず、ACK 監視中に届いた本文（takeAckWindowBodies）を使う
  // （キューに滞留したぶんもそこに含まれる。drain は二重注入と破棄ログの抑止）。
  // registry.remove() は worktree を消さない（cleanupWorktree は呼び出し側の責務）ので、
  // 同じ worktree／ブランチのまま作り直せる。
  const pending = agent.takeAckWindowBodies();
  agent.drainInjectQueue();
  registry.remove(id);
  broadcast({ type: "exited", id, exitCode: null });
  broadcastRegistry();
  // 旧プロセスの exit が処理されるまで待ってから作り直す。exit ハンドラは id だけを見て
  // registry から remove するため、待たずに新エビを立てると遅れて届いた旧 exit が
  // 新エビを kill してしまう（同一 id で作り直すこの経路に固有の罠）。
  if (!(await agent.awaitExit(ACK_RESPAWN_EXIT_WAIT_MS))) {
    console.warn(`[ebi-team] [${id}] 旧プロセスの exit を待てませんでした（作り直しは続行）`);
  }

  await spawnAgent({ ...params, id, retryOfAckFailure: true });

  if (pending.length === 0) return;
  const next = registry.get(id);
  if (!next) return;
  const ready = await next.waitUntilReady(READY_WAIT_MS);
  if (!ready) {
    logDelivery({
      event: "ack-failure-requeue-failed",
      level: "warn",
      msg: `${id} の再 spawn 後に ready 到達せず、滞留していた注入 ${pending.length} 件を引き継げませんでした`,
      id,
      count: pending.length,
    });
    return;
  }
  for (const body of pending) next.injectRaw(body);
  logDelivery({
    event: "ack-failure-requeued",
    level: "info",
    msg: `${id} の再 spawn 後に滞留注入 ${pending.length} 件を引き継ぎました`,
    id,
    count: pending.length,
  });
}

/**
 * ready 到達前の予期せぬ exit を 1 回だけ再試行する（backend.retryOnEarlyExit が true のとき）。
 *
 * 非ブロッキング（spawn の応答は待たせない）。判定は
 *   「READY_WAIT_MS 以内に ready にならず、かつ registry から消えている（= exit 済み）」
 * で行う。ready 待ちタイムアウトだけ（プロセスは生きている）では再試行しない
 * ——生きているエビを二重起動しないため。
 * 2 回目も ready 前に落ちたら notice で明示する（黙って消えるのが一番困る）。
 */
function watchEarlyExit(
  agent: Agent,
  backend: ReturnType<typeof getBackend>,
  params: GeneralizedSpawnParams,
): void {
  if (!backend.retryOnEarlyExit) return;
  const agentId = agent.id;
  void (async () => {
    const ready = await agent.waitUntilReady(READY_WAIT_MS);
    if (ready) return;
    // まだ registry に居る＝プロセスは生きている（単なる ready 待ちタイムアウト）。何もしない。
    if (registry.get(agentId) === agent) return;
    if (params.retryOfEarlyExit) {
      broadcast({
        type: "notice",
        id: agentId,
        text: `${agentId}（backend=${backend.id}）が ready 前に再び終了しました。再試行は打ち切ります（起動条件を確認してください）`,
      });
      console.error(`[spawn:${backend.id}] ${agentId} が ready 前に 2 回終了しました`);
      return;
    }
    broadcast({
      type: "notice",
      id: agentId,
      text: `${agentId}（backend=${backend.id}）が ready 前に終了しました。1 回だけ再起動します`,
    });
    try {
      await spawnAgent({ ...params, id: agentId, retryOfEarlyExit: true });
    } catch (err) {
      broadcast({
        type: "notice",
        id: agentId,
        text: `${agentId} の再起動に失敗しました: ${(err as Error).message}`,
      });
    }
  })();
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
  /** spawnIfMissing で起動する際のバックエンド（未指定は役割の既定→サーバ既定）。 */
  backend?: string;
  /** 【後方互換】spawnIfMissing で起動する際 engineer 役割にするか（既定 true 相当）。role が優先。 */
  asEngineer?: boolean;
}

/** sendMessage の結果。 */
export type SendMessageResult =
  | {
      ok: true;
      id: string;
      spawned: boolean;
      status: AgentStatus;
      /** 実際に使った配送経路（notify / pty-fallback / pty）。運用の可観測性・e2e の判定に使う。 */
      via: DeliverOutcome["via"];
      /** PTY 注入が busy で滞留した（idle 復帰時に flush）か。滞留は「相手が受け取った」ではない。 */
      queued: boolean;
    }
  | { ok: false; error: string; spawned: boolean };

/**
 * 統一メッセージ送信オーケストレーション。
 *
 * 「送信先セッションが立ち上がっているか／まだか」を自動判定して確実に届ける:
 *  1. 宛先が存在しない:
 *     - spawnIfMissing=false → { ok:false, error:"not found" }（notice も）
 *     - spawnIfMissing=true  → engineer として spawn（id は `to` を採用）→ spawned=true
 *  2. spawn 直後なら ready（起動ゲート応答済み＋入力受付）まで待つ。ここで待つのは、
 *     起動ゲート表示中に notification を push しても harness に黙って捨てられるため。
 *  3. notification 経路（購読 live）なら registry.deliver へ。deliver は ACK に加えて
 *     セッション到達（本文エコー）まで確認し、取れなければ PTY 注入へフォールバックする。
 *  4. notification が使えないなら ready を待って agent.inject（idle→即送信／busy→キュー）。
 *
 * 「すでに立ち上がっている」= 1・2 をスキップし 3/4 で送信。
 * 「まだ」= 1 で spawn → 2 で ready 待ち → 3/4 で送信。分岐はこの関数内で完結する。
 */
async function sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
  const { to, message } = params;
  const from = params.from ?? "user";

  let spawned = false;
  let agent = registry.get(to);

  // ---- 0. 宛先が chat master（PTY 無し）ならそのまま stdin へ投入して終わる ----
  // これが無いと spawnIfMissing 経路が「master という名前の PTY エビ」を新規 spawn してしまい、
  // chat セッションと同名の二重エビができる。
  if (!agent && registry.isChatTarget(to)) {
    const outcome = await registry.deliver(to, from, message);
    if (!outcome.ok) return { ok: false, error: "master（chat）へ投入できませんでした", spawned: false };
    return { ok: true, id: to, spawned: false, status: "idle", via: outcome.via, queued: false };
  }

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
      backend: params.backend,
    });
    spawned = true;
    agent = registry.get(to);
    if (!agent) {
      // 通常起きないが、spawn 直後に消えた場合の保険。
      return { ok: false, error: "spawn したが agent を取得できません", spawned };
    }
  }

  // ---- 1.5. spawn 直後は「入力受付（ready）」まで待ってから経路を選ぶ ----
  // 【2026-07-25 spawn 直後の本文消失の根治】
  // spawn 直後の claude は起動ゲート（dev-channels 警告 / workspace trust）で止まっており、
  // その間はセッションに ebi-control が channel として登録されていない（TUI に
  // `server:ebi-control · no MCP server configured with that name` が出る）。一方、制御MCP
  // ブリッジは別プロセスとして数百 ms で立ち上がり購読を張ってしまうため、購読確立だけを合図に
  // notification を push すると harness に黙って捨てられ、本文が痕跡ゼロで消えていた。
  // ready 判定は「起動ゲート応答済み＋idle」に強化してある（agent.ts）ので、spawn 直後だけ
  // ここで ready を待ってレース窓を潰す。ready を待てなくても配送自体は続行する
  // （notification 経路のセッション到達確認＋PTY フォールバックが後段で担保するため、
  // ここで失敗にして本文を捨てるより届ける方を優先する）。
  if (spawned) {
    const bootReady = await agent.waitUntilReady(READY_WAIT_MS);
    if (!bootReady) {
      broadcast({
        type: "notice",
        id: to,
        text: `${to} を spawn しましたが ready 待ちがタイムアウトしました（${READY_WAIT_MS}ms）。配送は継続します`,
      });
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
  // さらに、backend が channel 注入に対応しない場合（codex）もこの経路へ入らない。
  // 制御MCP ブリッジは持つ（reply_to_master は使える）が、受信側の channel が無いため
  // 購読は永遠に確立せず、待つだけ無駄になる。
  if (
    registry.notifyEnabled() &&
    hasControlBridge(agent) &&
    supportsChannelInject(agent) &&
    agent.notifySubscribe !== false
  ) {
    const subscribed =
      registry.hasActiveSubscriber(to) || (await registry.waitForSubscriber(to, SUBSCRIBE_WAIT_MS));
    if (subscribed) {
      // deliver は ACK＋セッション到達（本文エコー）確認を含み、取れなければ内部で PTY 注入へ
      // フォールバックする。
      const outcome = await registry.deliver(to, from, message);
      return { ok: true, id: to, spawned, status: agent.getStatus(), via: outcome.via, queued: outcome.queued };
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
  const state = agent.inject(from, message);
  return { ok: true, id: to, spawned, status: agent.getStatus(), via: "pty", queued: state === "queued" };
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
    const raw = await loadFixedEbi(CONFIG_PATH, { command: COMMAND, backend: BACKEND_ID });
    // master には役割別 MCP config を spawn 直前に自動付与する（config への手書きを不要にし、
    // dev / 本番のファイル名差分をサーバ側で吸収する）。args に明示があればそちらを優先。
    // master は backend=claude に固定する（config/env で他 backend を既定にしても統括系は落とさない）。
    // env EBI_MASTER_UI で ui を上書きできる（config を書き換えずに切り戻せる口）。
    const specs = raw.map((s) =>
      applyMasterUiOverride(
        applyMasterBackendFailsafe(applyMasterMcpConfig(s, ROLE_MCP_CONFIG.master)),
        process.env.EBI_MASTER_UI,
      ),
    );
    if (specs.length === 0) {
      console.log(`[ebi-team] 固定エビ: なし（${CONFIG_PATH} 未配置または fixedEbi 空）`);
      return;
    }
    // ui:"chat" の master だけ PTY 経路から外し、MasterSession（ヘッドレス頭脳）で起動する。
    // それ以外（ui 未指定/terminal）は従来どおり FixedEbiManager が PTY で spawn する
    // ＝ chat を使わない構成では外形ゼロ差分。
    const chatSpecs = specs.filter((s) => s.kind === "master" && s.ui === "chat");
    const ptySpecs = specs.filter((s) => !(s.kind === "master" && s.ui === "chat"));
    console.log(
      `[ebi-team] 固定エビを自動起動: ` +
        specs.map((s) => `${s.id}(${s.kind}${s.ui === "chat" ? "/chat" : ""})`).join(", "),
    );
    if (ptySpecs.length > 0) fixedEbi.start(ptySpecs, handlers);
    for (const spec of chatSpecs) {
      await startMasterChatSession(spec).catch((err) => {
        console.warn(`[ebi-team] master（chat）の起動に失敗:`, err);
        broadcast({
          type: "notice",
          id: spec.id,
          text: `master（chat）の起動に失敗しました: ${(err as Error).message}`,
        });
      });
    }
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

/**
 * ebi-team.config.json の top-level "defaultBackend" / "backends" を読み、サーバ既定へ反映する。
 * httpServer.listen()／固定エビ自動起動より前に完了させ、以降の spawn（および固定エビの
 * backend 解決）が常に config 反映後の既定を見るようにする。
 * config が無い/未指定なら何もしない。検証失敗時は警告のみで起動を継続する
 *（env EBI_BACKEND → claude の従来経路で動く）。
 */
async function loadAndApplyBackendSettings(): Promise<void> {
  try {
    backendSettings = await loadBackendSettings(CONFIG_PATH);
    BACKEND_ID = resolveBackendId({
      configDefault: backendSettings.defaultBackend,
      env: process.env.EBI_BACKEND,
    });
    if (backendSettings.defaultBackend || Object.keys(backendSettings.backends).length > 0) {
      console.log(
        `[ebi-team] バックエンド既定: ${BACKEND_ID}` +
          `（config 設定あり: ${Object.keys(backendSettings.backends).join(", ") || "なし"}）`,
      );
    }
  } catch (err) {
    console.warn(`[ebi-team] backends 設定の読み込みに失敗（env/既定で継続）:`, err);
  }
}

/**
 * ワンショット要約エンジン（ask_supervisor / WS summarize）の backend / model を
 * config の supervisor 固定エビから引き継ぐ。
 *
 * 常駐 supervisor セッションと要約エンジンで別々に backend を書かせない（config 1 箇所で揃う）。
 * supervisor 固定エビが無い / config が無い / 読み込みに失敗した場合は既定（claude/haiku）のまま。
 * EBI_SUMMARY_CMD（テスト用スタブ）が優先されるのは resolveSummaryEngine 側で担保している。
 */
async function loadAndApplySupervisorEngine(): Promise<void> {
  try {
    const specs = await loadFixedEbi(CONFIG_PATH, { command: COMMAND, backend: BACKEND_ID });
    const engine = supervisorEngineFrom(specs);
    if (!engine || engine.backend === DEFAULT_BACKEND_ID) return;
    supervisor = new Supervisor({ backend: engine.backend, model: engine.model });
  } catch (err) {
    console.warn(`[ebi-team] 監督・要約エンジン設定の読み込みに失敗（既定 claude で継続）:`, err);
  }
}

// spawn 要求（WS / 制御API いずれも）を受け付ける前にカスタム役割・許可リスト・
// バックエンド既定を確定させる。
await loadAndApplyBackendSettings();
await loadAndRegisterCustomRoles();
await loadAndApplyDevChannelsAllowlist();
await loadAndApplySupervisorEngine();

// 前回終了時に開いていた viewer を復元する（fail-soft: 個別エントリの失敗は warn して掃除）。
const viewerRestore = await viewerRegistry.restore();

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
  console.log(
    `[ebi-team] context-guard: ${contextGuardConfig.enabled ? "on" : "off"}`
      + ` / 監視対象=${contextGuardConfig.targetId}`
      + ` / soft=${contextGuardConfig.softPct}% notify=${contextGuardConfig.hardPct}% critical=${contextGuardConfig.criticalPct}%`,
  );
  console.log(
    `[ebi-team] viewer 永続化: ${VIEWERS_PATH}（復元 ${viewerRestore.restored.length}件` +
      `${viewerRestore.skipped.length > 0 ? ` / skip ${viewerRestore.skipped.length}件` : ""}）`,
  );
  console.log(`[ebi-team] 配送ログ: ${deliveryLogPath() ?? "（無効・console のみ）"}`);
  console.log(`[ebi-team] 固定エビログ: ${fixedEbiLogPath() ?? "（無効・console のみ）"}`);
  console.log(`[ebi-team] 使用率履歴: ${usageHistoryPath() ?? "（無効）"}`);
  console.log(`[ebi-team] master MCP config: ${ROLE_MCP_CONFIG.master}`);
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
  // chat master（PTY を持たない）は registry.killAll() の対象外なので個別に止める。
  void masterSession?.stop().catch(() => {});
  registry.killAll();
  for (const ws of clients) ws.close();
  httpServer.close(() => process.exit(0));
  // close が詰まる場合の保険。
  setTimeout(() => process.exit(0), 1000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
