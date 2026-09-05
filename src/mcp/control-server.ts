// エビチーム 制御MCP サーバ（stdio）。
//
// 役割:
// - claude セッションが --mcp-config 経由で読み込む stdio MCP サーバ。
// - ebi-team Node サーバの 127.0.0.1 限定 制御API（/control/*）への薄いブリッジ。
// - 公開ツールは EBI_MCP_ROLE で出し分ける（最小権限）:
//   - master（既定）: list_ebi / spawn_ebi / spawn_engineer / send_message / inject_message /
//     read_scrollback / set_mode / kill_engineer / ask_supervisor（配下のエビを統括）。
//   - engineer: reply_to_master + 参照系（list_ebi / read_scrollback）のみ。
//     spawn/kill/send/inject/set_mode/ask_supervisor は出さない（動的エビが他エビを
//     勝手に起動/操作しないための最小権限）。reply_to_master の from は env EBI_ID。
//     （動的エビは役割に関わらずこの "engineer" ティアで起動する。カスタム役割を追加する
//     場合も mcpRole: "engineer" を指定すればこの最小権限ティアを流用できる。roles.ts 参照）
//
// 役割ごとの appendSystemPrompt / permissionMode / 既定モデルは src/server/roles.ts の
// EBI_ROLES に集約されており、spawn 時にサーバ側（index.ts）が適用する。
// この MCP は role id を渡すだけで、プロンプト文面は持たない（重複定義の解消）。
//
// 接続先: env EBI_CONTROL_URL（既定 http://127.0.0.1:8787）。
//
// 注意: このプロセス自体は claude を起動しない。あくまで制御API を呼ぶブリッジ。

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { availableRoleIds, registerCustomRoles, type EbiRoleId } from "../server/roles.ts";
import { ALL_BACKEND_IDS } from "../server/backends/index.ts";
import { loadRawCustomRoles } from "../server/config.ts";
import { deliveryText } from "../shared/deliveryTag.ts";
import { resolveConfigPath } from "./configPath.ts";

const CONTROL_URL = (process.env.EBI_CONTROL_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

// role の選択肢と検証に、サーバ側（index.ts）が起動時にマージするのと同じカスタム役割を
// 反映させるため、ここでも registerCustomRoles を「ツールスキーマを組み立てる前」に呼ぶ。
//
// config の探索は **cwd に依存しない**（configPath.ts 参照）。この stdio MCP は
// gen-master-mcp.mjs が生成した mcp config の "cwd" どおりに起動されるとは限らず（実測:
// master のブリッジは master セッションのプロジェクトディレクトリで動いていた）、
// cwd 直下だけを見ると config が見つからず「役割は engineer だけ」に縮退する。
const CONFIG = resolveConfigPath({
  envPath: process.env.EBI_CONFIG_PATH,
  cwd: process.cwd(),
  moduleDir: dirname(fileURLToPath(import.meta.url)),
  exists: existsSync,
  join,
  dirname,
});
if (CONFIG.source === "missing") {
  console.error(
    `[ebi-control-mcp] ebi-team.config.json が見つからない（探索: env EBI_CONFIG_PATH → cwd=${process.cwd()} → モジュール位置の上位）。` +
      "カスタム役割は登録されず engineer のみになる",
  );
}
try {
  const rawRoles = await loadRawCustomRoles(CONFIG.path);
  registerCustomRoles(rawRoles);
} catch (err) {
  console.error(
    `[ebi-control-mcp] カスタム役割 config の読み込みに失敗（engineer のみで継続）: ${(err as Error).message}`,
  );
}

/**
 * notification 注入方式の long-poll 購読タイムアウト（ms）。
 * サーバ側 /control/subscribe はこの時間内に届いたメッセージを返し、無ければ空配列で
 * 返す（このブリッジは即座に再接続するので実質は「busy wait をサーバに肩代わりさせている」だけ）。
 * env `EBI_SUBSCRIBE_TIMEOUT_MS` で調整可。
 */
const SUBSCRIBE_TIMEOUT_MS = Number(process.env.EBI_SUBSCRIBE_TIMEOUT_MS) || 25000;

/**
 * notification（mailbox 購読）受信を有効にするか（既定 on）。
 * env `EBI_NOTIFY_SUBSCRIBE` が "off"/"0"/"false" のとき無効化し、subscribeLoop を回さない。
 *
 * 用途: 外部チャンネル待機セッション（minaebi 等）は自セッションに ebi-control channel を
 * 登録しないため、notification 注入は harness に黙って捨てられる（既知トラップ）。この経路を
 * 使わず「受信は PTY 注入に固定・送信は reply_to_master(HTTP)」で運用するために購読自体を止める。
 * 純関数として切り出してユニットテスト可能にしている。
 */
export function isNotifySubscribeEnabled(raw: string | undefined): boolean {
  return !["off", "0", "false"].includes((raw ?? "on").toLowerCase());
}

/** 自分の agent id（index.ts が spawn 時に全経路で launch env へ注入する）。 */
const EBI_ID = process.env.EBI_ID ?? null;

/**
 * 購読者トークン（このブリッジ・プロセス 1 本を一意に識別する）。
 *
 * 【2026-08-04 二重購読の可視化・拒否】
 * 同じ EBI_ID を名乗る別プロセス（claude デーモンの予備セッションが業務用 MCP 設定を抱えたまま
 * claim された、など）が購読すると、旧実装では 2 本が互いを蹴り出し合い、メッセージが
 * coin flip でどちらかに配られていた（master 宛の約半分が幽霊側へ吸われた実障害）。
 * サーバはこのトークンで購読の所有権を管理し、後着を 409 で拒否する。
 * pid だけだと再起動で衝突しうるので、起動時乱数を足して一意にする。
 */
const SUBSCRIBER_TOKEN = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * 二重購読として拒否（409）されたときの再試行間隔（ms）。
 * 正規の所有者が生きている限り拒否され続けるので、短間隔で叩き続けない
 * （＝旧実装の「互いに蹴り出し合って CPU が張り付く」の再来を防ぐ）。
 * 所有者が消えれば所有権は失効し、この再試行で正しく引き継げる。
 */
const DUPLICATE_RETRY_MS = Number(process.env.EBI_DUPLICATE_RETRY_MS) || 60000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * MCP ロール。env EBI_MCP_ROLE で切り替える（既定 master）。
 * engineer（動的エビの最小権限ティア）のときは最小権限のツールセットだけを公開する。
 */
const ROLE = process.env.EBI_MCP_ROLE === "engineer" ? "engineer" : "master";

/**
 * spawn_ebi / send_message の role パラメータ。
 *
 * **z.enum ではなく z.string()** にしている。理由（2026-09-05 の実障害）:
 * 役割一覧は config 駆動で動的（roles.imagegen を足すなど）なのに、enum はこの stdio
 * ブリッジ**プロセスの起動時点**のスナップショットで固まる。config を読めていなかったり、
 * サーバだけ再起動して役割を足したりすると、ブリッジの zod が呼び出しを先に弾いてしまい
 * 「サーバ側は知っている役割なのに master からは永久に使えない」状態になる。
 * 役割の妥当性判定の SoT は**稼働中のサーバ**（/control/spawn → spawnAgent）に一本化し、
 * 未知の役割はサーバが利用可能な役割名を列挙したエラーで返す（roles.ts unknownRoleError）。
 * ここでは選択肢を説明文で案内するだけに留める。
 */
const ROLE_PARAM = z.string().min(1);

/** ツール説明に載せる、現在このブリッジが把握している役割一覧（config マージ後）。 */
function roleChoicesText(): string {
  return availableRoleIds().join(" / ");
}

/**
 * spawn_ebi / spawn_engineer / send_message で指定できる backend id。
 * claude / codex / gemini とも実装済み（PR-C / PR-D）。実装済みでない id を渡した場合は
 * サーバ側（spawnAgent → resolveBackendId）が明示エラーで弾く。
 */
const BACKEND_IDS = [...ALL_BACKEND_IDS] as [string, ...string[]];
const BACKEND_DESC =
  "バックエンド（省略時は役割の既定 → config.defaultBackend → env EBI_BACKEND → claude）。" +
  "claude / codex / gemini とも実装済み。" +
  "codex / gemini は cost・context を報告しない（ダッシュボードは「—（未対応）」表示）ほか、" +
  "model は backend ごとに語彙が違う（claude の opus/sonnet は codex/gemini では不可）";

/** 制御API を呼ぶ共通ヘルパー。失敗時は { ok:false, error } を返す（throw しない）。 */
async function callControl(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${CONTROL_URL}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...(signal ? { signal } : {}),
    });
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const errMsg =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : `HTTP ${res.status}`;
      return { ok: false, error: errMsg };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `制御APIへ接続できません（${CONTROL_URL}）: ${(err as Error).message}` };
  }
}

/** ツール結果を MCP の content 形式（テキスト）に整える。 */
function textResult(value: unknown, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }], isError };
}

/** 制御API 呼び出し結果を MCP 結果へ変換する。 */
function toResult(r: { ok: true; data: unknown } | { ok: false; error: string }) {
  return r.ok ? textResult(r.data) : textResult(`エラー: ${r.error}`, true);
}

/**
 * MCP サーバ本体。
 *
 * capabilities.experimental["claude/channel"] の宣言が notification 注入の必須条件
 * （2026-07-11 harness バイナリ解析で確定。未宣言だと `notifications/claude/channel` が
 * honor されず静かに skip される＝過去 2 回の検証不成立の直接原因）。
 * もう一つの条件「サーバ名がセッションの channels に載っていること」は、spawn 側が
 * `--dangerously-load-development-channels server:ebi-control` を付けて満たす（src/server/index.ts）。
 */
const server = new McpServer(
  { name: "ebi-team-control", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {},
      },
    },
  },
);

// ===== 両ロール共通: 参照系 =====

// ---- list_ebi: 現在のエビ一覧 ----
server.tool(
  "list_ebi",
  "現在のエビ（agent）一覧を返す。id/kind/status/mode/model/branch/cwd を確認できる。",
  {},
  async () => {
    const r = await callControl("GET", "/control/agents");
    return toResult(r);
  },
);

// ---- read_scrollback: エビの出力を読む（両ロール共通の参照系）----
server.tool(
  "read_scrollback",
  "指定エビの出力（スクロールバック）を読む。完了/詰まりの確認に使う。tail で末尾 N 文字に絞れる。",
  {
    id: z.string().describe("対象エビ id"),
    tail: z.number().optional().describe("末尾 N 文字だけ取得（未指定は全保持分）"),
  },
  async ({ id, tail }) => {
    const qs = new URLSearchParams({ id });
    if (tail) qs.set("tail", String(tail));
    const r = await callControl("GET", `/control/scrollback?${qs.toString()}`);
    if (!r.ok) return textResult(`エラー: ${r.error}`, true);
    const data = (r.data as { data?: string }).data ?? "";
    return textResult(data);
  },
);

// ===== engineer ロール専用: master への逆方向通知 =====
if (ROLE === "engineer") {
  // ---- reply_to_master: 自分の結果/返信を master セッションへ直接 push（A の入口）----
  server.tool(
    "reply_to_master",
    "自分の作業結果・返信・完了報告を master のセッションへ直接届ける。" +
      "長いタスクの完了時や、master からの問いに答える時に使う（master はポーリング不要になる）。",
    { message: z.string().describe("master に届ける本文（結論ファースト・簡潔に）") },
    async ({ message }) => {
      // from は起動時に env で注入される自分の id（無ければ unknown）。
      const from = process.env.EBI_ID ?? "unknown";
      const r = await callControl("POST", "/control/reverse-inject", {
        from,
        to: "master",
        message,
        kind: "reply",
      });
      return toResult(r);
    },
  );
}

// ===== master ロール専用: 配下のエビを統括する制御系 =====
// engineer（動的エビ）には出さない（spawn/kill/send/inject/set_mode/ask_supervisor の最小権限化）。
if (ROLE === "master") {

// ---- permission_prompt: 承認 / 質問をボスの UI へ回す（master 専用・PR-M5）----
//
// これは **claude 本体が `--permission-prompt-tool` として呼ぶ**ツールで、モデルが
// 自発的に呼ぶものではない（呼ばれても実害は無いが、意味は無い）。
//
// 実測（PR-M5・設計書 §0.6）:
//  - 引数は `{tool_name, input, tool_use_id}`。承認の往復は claude の NDJSON には出ない
//  - **AskUserQuestion も同じツールを通る**。答えを返すには
//    `{"behavior":"allow","updatedInput":{...input, answers:{"<質問文>":"<回答>"}}}` を返す
//    （answers 無しで allow すると `The user did not answer the questions.` になる）
//  - 返す JSON は content[0].text にそのまま入れる（isError にはしない）
//
// サーバは**ボスが答えるまで応答を返さない**ので、この await は数分〜無限に待つ。
// 途中で claude がツール呼び出しを諦めると extra.signal が発火し、fetch の中断が
// サーバ側の保留破棄（＝deny）に繋がる。
server.tool(
  "permission_prompt",
  "（Claude Code 内部用）ツール実行の承認・ユーザーへの質問をボスのチャット UI へ回し、" +
    "回答が返るまで待つ。--permission-prompt-tool から呼ばれる想定で、通常はモデルから呼ばない。",
  {
    tool_name: z.string().describe("承認対象のツール名"),
    input: z.any().optional().describe("承認対象のツール入力"),
    tool_use_id: z.string().optional().describe("対応する tool_use の id"),
  },
  async ({ tool_name, input, tool_use_id }, extra) => {
    const r = await callControl(
      "POST",
      "/control/chat-permission",
      { tool_name, input, tool_use_id },
      extra?.signal,
    );
    if (!r.ok) {
      // 承認 UI へ到達できないときは**拒否**に倒す（黙って実行させない）。
      return textResult(
        JSON.stringify({ behavior: "deny", message: `承認 UI へ到達できません: ${r.error}` }),
      );
    }
    return textResult(JSON.stringify(r.data));
  },
);

/**
 * 役割付きの動的エビを起動して task を注入する共通処理。
 * spawn_ebi（汎用）と spawn_engineer（後方互換ラッパ）の双方から使う。
 * プロンプト/permission/既定モデルはサーバ側が EBI_ROLES から適用する。
 */
async function spawnRoleAndInject(args: {
  role: EbiRoleId;
  task: string;
  model?: string;
  backend?: string;
  cwd?: string;
  useWorktree?: boolean;
  repoPath?: string;
  branch?: string;
}) {
  const { role, task, model, backend, cwd, useWorktree, repoPath, branch } = args;
  const spawnRes = await callControl("POST", "/control/spawn", {
    role,
    model,
    backend,
    cwd,
    useWorktree,
    repoPath,
    branch,
    kind: "dynamic",
  });
  if (!spawnRes.ok) return textResult(`spawn 失敗: ${spawnRes.error}`, true);
  const id = (spawnRes.data as { id?: string }).id;
  if (!id) return textResult(`spawn 応答に id がありません: ${JSON.stringify(spawnRes.data)}`, true);

  // 起動直後はまだ busy（プロンプト初期化中）。idle になればサーバ側がキューを flush するので、
  // ここでは inject を投げておけば busy 時は自動でキューに積まれ、idle 復帰で流れる。
  const injectRes = await callControl("POST", "/control/inject", {
    to: id,
    from: "master",
    message: task,
  });
  if (!injectRes.ok) {
    return textResult(
      `${role} ${id} を起動したが task 注入に失敗: ${injectRes.error}（手動で inject_message してください）`,
      true,
    );
  }
  return textResult({ id, note: `${role} ${id} を起動し task を委譲した（idle 復帰時に実行される）` });
}

// ---- spawn_ebi: 役割を指定して動的エビを起動しタスクを委譲（汎用）----
server.tool(
  "spawn_ebi",
  "役割(role)を指定して動的エビを起動しタスクを委譲する。engineer=実装（既定で同梱される汎用役割）。" +
    `現在利用可能な役割: ${roleChoicesText()}。` +
    "プロンプト・権限・既定モデルは役割レジストリ（EBI_ROLES）から自動適用される。{ id } を返す。",
  {
    role: ROLE_PARAM.describe(
      `役割（現在利用可能: ${roleChoicesText()}）。engineer=実装。` +
        "役割は ebi-team.config.json の roles で追加でき、未知の役割はサーバが利用可能な一覧付きで拒否する",
    ),
    task: z.string().describe("委譲するタスク内容（起動後に注入される）"),
    model: z.string().optional().describe("モデル上書き（未指定は役割の既定モデル）"),
    backend: z.enum(BACKEND_IDS).optional().describe(BACKEND_DESC),
    cwd: z.string().optional().describe("作業ディレクトリ（未指定はサーバ既定）"),
    useWorktree: z.boolean().optional().describe("true なら git worktree を切って隔離 cwd で起動"),
    repoPath: z.string().optional().describe("worktree の元 repo パス"),
    branch: z.string().optional().describe("worktree ブランチ名（未指定は ebi/<id> 採番）"),
  },
  async (args) => spawnRoleAndInject(args),
);

// ---- spawn_engineer: engineer エビを起動してタスクを委譲（spawn_ebi の後方互換ラッパ）----
server.tool(
  "spawn_engineer",
  "engineer エビ(Opus)を起動してタスクを委譲する（spawn_ebi({role:\"engineer\"}) の後方互換ラッパ）。{ id } を返す。",
  {
    task: z.string().describe("engineer に委譲するタスク内容（起動後に注入される）"),
    model: z.string().optional().describe("モデル（既定 opus）"),
    backend: z.enum(BACKEND_IDS).optional().describe(BACKEND_DESC),
    cwd: z.string().optional().describe("作業ディレクトリ（未指定はサーバ既定）"),
    useWorktree: z.boolean().optional().describe("true なら git worktree を切って隔離 cwd で起動"),
    repoPath: z.string().optional().describe("worktree の元 repo パス"),
    branch: z.string().optional().describe("worktree ブランチ名（未指定は ebi/<id> 採番）"),
  },
  async (args) => spawnRoleAndInject({ ...args, role: "engineer" }),
);

// ---- send_message: 統一送信（推奨の主経路）----
server.tool(
  "send_message",
  "【推奨】統一メッセージ送信ツール。送信先エビが無ければ role 指定の役割（既定 engineer）として spawn し、" +
    "入力受付(ready)になるまで待ってから確実に送信する。既存エビにも使える（その場合は ready 即時で送信）。" +
    "spawnIfMissing=true で未起動エビを自動起動できる。spawn_ebi / inject_message は低レベル代替。",
  {
    to: z.string().describe("送信先エビ id。未起動なら spawnIfMissing=true で自動起動できる"),
    message: z.string().describe("送る本文（タスク内容や指示）"),
    spawnIfMissing: z
      .boolean()
      .optional()
      .describe("送信先が存在しない場合に role の役割で自動起動するか（既定 false）"),
    role: ROLE_PARAM.optional().describe(
      `spawnIfMissing で起動する役割（現在利用可能: ${roleChoicesText()}。既定 engineer）`,
    ),
    model: z.string().optional().describe("spawn 時のモデル上書き（未指定は役割の既定）"),
    backend: z.enum(BACKEND_IDS).optional().describe(`spawn 時の${BACKEND_DESC}`),
    cwd: z.string().optional().describe("spawn 時の作業ディレクトリ（未指定はサーバ既定）"),
    useWorktree: z.boolean().optional().describe("spawn 時に git worktree を切って隔離 cwd で起動"),
    repoPath: z.string().optional().describe("worktree の元 repo パス"),
    branch: z.string().optional().describe("worktree ブランチ名（未指定は ebi/<id> 採番）"),
  },
  async ({ to, message, spawnIfMissing, role, model, backend, cwd, useWorktree, repoPath, branch }) => {
    const r = await callControl("POST", "/control/send", {
      to,
      message,
      from: "master",
      spawnIfMissing,
      // 未起動の宛先を spawn する場合の役割（既定 engineer）。
      role: role ?? "engineer",
      model,
      backend,
      cwd,
      useWorktree,
      repoPath,
      branch,
    });
    return toResult(r);
  },
);

// ---- inject_message: 既存エビへ指示注入 ----
server.tool(
  "inject_message",
  "既存エビへ指示を注入する。to に \"all\" を指定すると connected な全エビへ一斉注入。",
  {
    to: z.string().describe("送信先エビ id。\"all\" で一斉注入"),
    message: z.string().describe("注入する指示内容"),
  },
  async ({ to, message }) => {
    const r = await callControl("POST", "/control/inject", { to, from: "master", message });
    return toResult(r);
  },
);

// ---- set_mode: 接続モード切替 ----
server.tool(
  "set_mode",
  "エビの接続モードを切り替える（connected: 疎通 / isolated: 隔離）。",
  {
    id: z.string().describe("対象エビ id"),
    mode: z.enum(["connected", "isolated"]).describe("connected または isolated"),
  },
  async ({ id, mode }) => {
    const r = await callControl("POST", "/control/setMode", { id, mode });
    return toResult(r);
  },
);

// ---- kill_engineer: dynamic エビを kill ----
server.tool(
  "kill_engineer",
  "動的エビ（engineer 等）を kill する。固定エビ（master/supervisor）は拒否される。",
  {
    id: z.string().describe("kill する dynamic エビ id"),
  },
  async ({ id }) => {
    const r = await callControl("POST", "/control/kill", { id });
    return toResult(r);
  },
);

// ---- open_viewer: md/txt/画像ファイルを読み取り専用パネルとして UI に開く（master 専用）----
server.tool(
  "open_viewer",
  "指定した md/txt/画像ファイルを、UI の読み取り専用プレビュー（viewer）として開く。" +
    "レビュー用のプランやレポート、エビが生成した画像をユーザーに『見せる』ための明示操作。" +
    "開くと自動でそのパネルに切り替わる。" +
    "パスは許可ルート（既定 $HOME/workspace・EBI_VIEWER_ROOTS で設定）配下の " +
    ".md/.markdown/.txt/.png/.jpg/.jpeg/.webp/.gif のみ。",
  {
    path: z
      .string()
      .describe("開くファイルの絶対パス（許可ルート配下の .md/.markdown/.txt/.png/.jpg/.jpeg/.webp/.gif）"),
    title: z.string().optional().describe("表示タイトル（未指定はファイル名）"),
  },
  async ({ path, title }) => {
    const r = await callControl("POST", "/control/open-viewer", { path, title });
    return toResult(r);
  },
);

// ---- ask_supervisor: target エビの状況要約を回収して返す（バッチC 本実装）----
server.tool(
  "ask_supervisor",
  "対象エビの直近ターミナルログを Haiku（サブスク claude CLI のワンショット要約）で要約し、" +
    "その要約テキストをツール結果として返す。master が engineer の状況を手元に回収するのに使う。",
  {
    target_id: z.string().describe("要約してほしい対象エビ id"),
  },
  async ({ target_id }) => {
    // 制御API の要約経路を叩き、要約テキストを構造的に回収して返す。
    // （常駐 supervisor セッションへ inject するのではなく、ワンショット --print で要約する）
    const r = await callControl("POST", "/control/summarize", { id: target_id });
    if (!r.ok) return textResult(`要約に失敗: ${r.error}`, true);
    const text = (r.data as { text?: string }).text ?? "";
    if (!text) return textResult("要約が空でした", true);
    // 要約テキストをそのままツール結果として返す（master の手元に状況サマリが返る）。
    return textResult(`${target_id} の要約:\n${text}`);
  },
);
} // end if (ROLE === "master")

/**
 * notification 注入方式の購読ループ（PTY 入力欄タイプ方式からの移行の本体）。
 *
 * 自分（EBI_ID）宛のメッセージを制御API へ long-poll 購読し、届いたら
 * `notifications/claude/channel` を emit して自セッションへ注入する。
 * サーバの /control/subscribe は最大 SUBSCRIBE_TIMEOUT_MS 待って空配列を返す設計なので、
 * 空配列が返ったら即座に再接続するだけで「常時購読」が成立する（busy wait はサーバ側で完結）。
 *
 * 接続エラー時は指数バックオフ（500ms→上限10s）で再接続する。
 * EBI_ID が無い（このプロセスが役割なしで起動された等）場合は購読自体を行わない
 * （reply_to_master 等は元々 master ロールでは出さないため実害は無い）。
 */
async function subscribeLoop(): Promise<void> {
  if (!isNotifySubscribeEnabled(process.env.EBI_NOTIFY_SUBSCRIBE)) {
    console.error(
      "[ebi-control-mcp] EBI_NOTIFY_SUBSCRIBE=off のため notification 購読を無効化します" +
        "（受信は PTY 注入・送信は reply_to_master(HTTP) で運用）",
    );
    return;
  }
  if (!EBI_ID) {
    console.error("[ebi-control-mcp] EBI_ID 未設定のため notification 購読はスキップします");
    return;
  }
  let backoffMs = 500;
  for (;;) {
    try {
      const qs = new URLSearchParams({
        id: EBI_ID,
        timeoutMs: String(SUBSCRIBE_TIMEOUT_MS),
        token: SUBSCRIBER_TOKEN,
      });
      const res = await fetch(`${CONTROL_URL}/control/subscribe?${qs.toString()}`, {
        signal: AbortSignal.timeout(SUBSCRIBE_TIMEOUT_MS + 5000),
      });
      if (res.status === 409) {
        // 二重購読として拒否された＝同じ id を名乗る別プロセスが先に座っている。
        // 蹴り合いにならないよう長めに待ってから再試行する（所有者が消えれば引き継げる）。
        const detail = await res.text().catch(() => "");
        console.error(
          `[ebi-control-mcp] id=${EBI_ID} の購読を拒否されました（二重購読）。` +
            `${DUPLICATE_RETRY_MS}ms 後に再試行します。詳細: ${detail}`,
        );
        await sleep(DUPLICATE_RETRY_MS);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        messages?: Array<{ id?: number; from: string; message: string; kind?: string; ts: number }>;
      };
      backoffMs = 500; // 成功したらバックオフをリセット。
      const ackIds: number[] = [];
      for (const m of data.messages ?? []) {
        // 行頭タグは deliveryTag() で組み立てる。PTY 注入経路（src/server/agent.ts inject()）と
        // **完全に同じ表記**にするのが不変条件で、これが二重配送抑止の照合キーそのものになる
        // （ここだけ書式を変えると抑止が静かに壊れる。詳細は src/shared/deliveryTag.ts 冒頭）。
        // 現行の [from:xxx] タグ相当の情報を content にも残しつつ、meta にも構造化して積む
        // （content はセッションへそのまま見える本文・meta は将来の機械的な判別用）。
        // 前提条件（どちらか欠けると harness に静かに skip される。registry.ts 参照）:
        //   1. 本サーバの capabilities.experimental["claude/channel"] 宣言（上部で宣言済み）
        //   2. spawn 時の --dangerously-load-development-channels server:ebi-control（index.ts 配線）
        // meta の値は harness の zod スキーマ上 string のみ許容。数値等は必ず String() する。
        await server.server.notification({
          method: "notifications/claude/channel",
          params: {
            content: deliveryText(m.from, m.message, m.id),
            meta: {
              from: m.from,
              kind: m.kind ?? "message",
              ts: String(m.ts),
              ...(typeof m.id === "number" ? { msgId: String(m.id) } : {}),
            },
          },
        });
        if (typeof m.id === "number") ackIds.push(m.id);
      }
      // 到達確認（end-to-end ACK）: emit した seq id 群をサーバへ返す。これによりサーバ側の
      // deliver() は「ブリッジが生きていてセッションへ確かに転送した」ことを確認でき、ACK が
      // 取れないメッセージは PTY 注入へフォールバックされる（黙って消えるのを防ぐ肝）。
      // best-effort（失敗しても購読ループは継続。次段の可視化/フォールバックで担保）。
      if (ackIds.length > 0) {
        void fetch(`${CONTROL_URL}/control/ack`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: EBI_ID, ids: ackIds }),
        }).catch(() => {});
      }
    } catch (err) {
      console.error(
        `[ebi-control-mcp] notification 購読エラー（${backoffMs}ms 後に再接続）: ${(err as Error).message}`,
      );
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 10000);
    }
  }
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio MCP は stdout を JSON-RPC に使うため、ログは stderr に出す。
  console.error(`[ebi-control-mcp] 起動。role=${ROLE} 制御API 接続先: ${CONTROL_URL}`);
  // 購読ループはバックグラウンドで走らせる（main の完了を待たせない・無限ループのため await しない）。
  void subscribeLoop();
}

// エントリポイントとして直接実行されたときだけ起動する（import 時は起動しない＝ユニットテストで
// 純関数 isNotifySubscribeEnabled 等を import しても stdio 接続/購読ループが走らないようにする）。
// 本番/開発の起動経路（gen-master-mcp.mjs 生成の mcp config: `node dist/.../control-server.js` /
// `npx tsx src/mcp/control-server.ts`）はいずれも argv[1] がこのファイル自身になり true になる。
const isEntryPoint =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((err) => {
    console.error("[ebi-control-mcp] 致命的エラー:", err);
    process.exit(1);
  });
}
