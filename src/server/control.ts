// 127.0.0.1 限定の HTTP 制御API（ebi-team Node サーバに同居）。
//
// 設計方針:
// - master(Opus) を仲介する stdio 制御MCP（src/mcp/control-server.ts）から叩くための
//   ローカル専用 REST。外部公開しない（bind は index.ts 側で 127.0.0.1 固定）。
// - WS（ルームUI）とは独立。エビの spawn / inject / scrollback / mode / kill を JSON で受ける。
// - 入力検証・エラーは JSON（{ error } / 4xx, 5xx）で返す。
// - 既存ロジックは流用する: spawn は index.ts の一般化済み spawnAgent、inject は
//   registry.resolveAndInject、kill は pinned 拒否（dynamic のみ）。

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Registry } from "./registry.ts";
import type { MailboxMessage } from "./mailbox.ts";
import { BROADCAST_TARGET, type AgentMode, type AgentKind, type ViewerRecord } from "../shared/protocol.ts";

/**
 * spawn の一般化パラメータ（WS / 制御API 共通）。
 * 動的 engineer エビを制御API から起動するため、model / appendSystemPrompt /
 * permissionMode / kind まで受けられる。
 */
export interface GeneralizedSpawnParams {
  id?: string;
  cwd?: string;
  useWorktree?: boolean;
  repoPath?: string;
  branch?: string;
  /** 起動モデル（alias/full ID）。claude command 時のみ --model に展開。 */
  model?: string | null;
  /** 役割注入（--append-system-prompt）。 */
  appendSystemPrompt?: string | null;
  /** permission-mode（未検証文字列。spawnAgent 側で検証）。 */
  permissionMode?: string;
  /** エビ種別（既定 dynamic）。 */
  kind?: AgentKind;
  /**
   * 役割（roles.ts の EBI_ROLES id。既定同梱は engineer。カスタム役割を追加可能）。
   * 指定すると index.ts 側で役割の appendSystemPrompt / permissionMode / 既定モデル /
   * 役割別 MCP config（--mcp-config）を適用し、EBI_ID を pty env に注入する。
   * 明示指定（model / appendSystemPrompt / permissionMode）があればそちらが勝つ。
   * UI 等の素の dynamic spawn は未指定のまま（役割 MCP を付けない）。
   */
  role?: string;
  /**
   * 【後方互換】engineer 役割として起動するか（既定 false）。
   * role 未指定かつ true のとき role="engineer" と等価に扱う（index.ts 側で読み替え）。
   */
  asEngineer?: boolean;
}

/** 要約結果（control.ts は supervisor.ts の型に依存しないよう最小形で受ける）。 */
export type SummarizeOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/** sendMessage（統一送信）の入力パラメータ（control.ts 側の最小形）。 */
export interface SendMessageInput {
  to: string;
  message: string;
  from?: string;
  spawnIfMissing?: boolean;
  model?: string | null;
  cwd?: string;
  useWorktree?: boolean;
  repoPath?: string;
  branch?: string;
  /** spawnIfMissing で起動する際の役割（EBI_ROLES id。未指定は engineer）。 */
  role?: string;
  /** 【後方互換】spawnIfMissing で起動する際 engineer 役割にするか。role が優先。 */
  asEngineer?: boolean;
}

/** sendMessage の結果（index.ts の SendMessageResult と互換な最小形）。 */
export type SendMessageOutcome =
  | { ok: true; id: string; spawned: boolean; status: string }
  | { ok: false; error: string; spawned: boolean };

/** 制御API が依存する処理（index.ts から注入する）。 */
export interface ControlDeps {
  registry: Registry;
  /** spawn の中核。spawned/registry ブロードキャストまで行い agent id を返す。 */
  spawnAgent: (params: GeneralizedSpawnParams) => Promise<string>;
  /**
   * 注入（registry.resolveAndInject ラッパ）。到達確認（ACK 待ち）を含むため async。
   * delivered / rejected に加え details（宛先ごとの配送経路・到達確認）を返す。
   */
  inject: (
    to: string,
    from: string,
    message: string,
  ) => Promise<{
    delivered: string[];
    rejected: { id: string; reason: string }[];
    details: { id: string; via: string; confirmed: boolean }[];
  }>;
  /**
   * 統一送信（送信先が無ければ spawn し、ready まで待ってから確実に送信する）。
   * 「立ち上がってる／まだ」の分岐は index.ts の sendMessage 内で完結する。
   */
  sendMessage: (input: SendMessageInput) => Promise<SendMessageOutcome>;
  /** mode 切替後に registry ブロードキャストする。 */
  broadcastRegistry: () => void;
  /**
   * 対象エビの直近スクロールバックをワンショット要約エンジン（claude --print）で要約する。
   * master が ask_supervisor から要約テキストを構造的に回収するための経路。
   */
  summarize: (id: string) => Promise<SummarizeOutcome>;
  /**
   * 使用状況（usage）の取り込み。各エビの statusLine が `/control/usage` に POST してくる
   * statusLine JSON 全体を ebiId 付きで受け、ストアを更新してから WS `usage` を broadcast する。
   */
  ingestUsage: (ebiId: string, json: unknown) => void;
  /**
   * notification 注入方式の long-poll 購読。各エビの制御MCP ブリッジ
   * （src/mcp/control-server.ts）が起動時にこれへ接続し、届いたメッセージを
   * notifications/claude/channel として自セッションへ注入する。
   * pending があれば即返し、無ければ timeoutMs 待って空配列（=再接続を促す）を返す。
   */
  subscribe: (id: string, timeoutMs: number) => Promise<MailboxMessage[]>;
  /**
   * viewer（読み取り専用の md/txt プレビュー）を開く。パス検証・ファイル読取・登録を行い、
   * viewers の broadcast まで済ませて登録された ViewerRecord を返す。
   * 検証失敗（許可ルート外/拡張子/サイズ/不存在）は throw（呼び出し側で 400 に振り分ける）。
   */
  openViewer: (path: string, title?: string) => Promise<ViewerRecord>;
}

/** JSON レスポンスを返すヘルパー。 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

/** リクエストボディ（JSON）を読み取る。上限 1MB。空ボディは {} 扱い。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  const LIMIT = 1024 * 1024;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > LIMIT) throw new Error("リクエストボディが大きすぎます");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON オブジェクトを指定してください");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`JSON パース失敗: ${(err as Error).message}`);
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/** registry の AgentRecord から制御API が返す要約形に整える。 */
function agentSummary(registry: Registry) {
  return registry.list().map((a) => ({
    id: a.id,
    kind: a.kind,
    role: a.role,
    status: a.status,
    mode: a.mode,
    model: a.model,
    branch: a.branch,
    cwd: a.cwd,
    pinned: a.pinned,
    pid: a.pid,
  }));
}

/**
 * 制御API のリクエストハンドラを作る。
 * 返り値は「このリクエストが /control/* で処理されたか」を示す boolean を返す関数。
 * false の場合、呼び出し側（index.ts）は従来どおり静的配信などにフォールバックする。
 */
export function createControlApi(deps: ControlDeps) {
  const { registry, spawnAgent, inject, sendMessage, broadcastRegistry, summarize, ingestUsage, subscribe, openViewer } = deps;

  return async function handleControl(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: URLSearchParams,
  ): Promise<boolean> {
    if (!pathname.startsWith("/control/")) return false;

    const method = req.method ?? "GET";

    try {
      // ---- GET /control/agents ----
      if (pathname === "/control/agents" && method === "GET") {
        sendJson(res, 200, { agents: agentSummary(registry) });
        return true;
      }

      // ---- POST /control/spawn ----
      if (pathname === "/control/spawn" && method === "POST") {
        const body = await readJsonBody(req);
        const kindRaw = asString(body.kind);
        if (kindRaw && kindRaw !== "master" && kindRaw !== "supervisor" && kindRaw !== "dynamic") {
          sendJson(res, 400, { error: `kind が不正です: ${kindRaw}` });
          return true;
        }
        const id = await spawnAgent({
          model: asString(body.model) ?? null,
          cwd: asString(body.cwd),
          useWorktree: asBool(body.useWorktree),
          repoPath: asString(body.repoPath),
          branch: asString(body.branch),
          appendSystemPrompt: asString(body.appendSystemPrompt) ?? null,
          permissionMode: asString(body.permissionMode),
          kind: (kindRaw as AgentKind | undefined) ?? "dynamic",
          role: asString(body.role),
          asEngineer: asBool(body.asEngineer),
        });
        sendJson(res, 200, { id });
        return true;
      }

      // ---- POST /control/open-viewer ----
      // master 専用 MCP `open_viewer` からのブリッジ。パス検証・読取・登録・broadcast は
      // openViewer（index.ts 側）が行う。content は大きいので応答には含めず要約だけ返す。
      if (pathname === "/control/open-viewer" && method === "POST") {
        const body = await readJsonBody(req);
        const path = asString(body.path);
        const title = asString(body.title);
        if (!path) {
          sendJson(res, 400, { error: "path（文字列）は必須です" });
          return true;
        }
        try {
          const rec = await openViewer(path, title);
          sendJson(res, 200, { id: rec.id, path: rec.path, title: rec.title, format: rec.format });
        } catch (err) {
          // パス検証エラー（許可ルート外/拡張子/サイズ/不存在）は 400 で理由を返す。
          sendJson(res, 400, { error: (err as Error).message });
        }
        return true;
      }

      // ---- POST /control/usage ----
      // 各エビの statusLine コマンドが best-effort で投げてくる statusLine JSON 全体を受ける。
      // 識別子（ebiId）は ヘッダ X-Ebi-Id / query ?ebiId= / body.ebiId のいずれか。
      // 不明な ebiId でも受理する（緩く）。値検証は最小。更新後に WS `usage` を broadcast。
      if (pathname === "/control/usage" && method === "POST") {
        const body = await readJsonBody(req);
        const headerId = req.headers["x-ebi-id"];
        const ebiId =
          (typeof headerId === "string" ? headerId : undefined) ??
          query.get("ebiId") ??
          asString(body.ebiId);
        if (!ebiId) {
          sendJson(res, 400, { error: "ebiId（X-Ebi-Id ヘッダ / ?ebiId= / body.ebiId）が必要です" });
          return true;
        }
        // body 全体を statusLine JSON として取り込む（ebiId フィールドが混じっていても無害）。
        ingestUsage(ebiId, body);
        sendJson(res, 200, { ok: true, ebiId });
        return true;
      }

      // ---- POST /control/inject ----
      if (pathname === "/control/inject" && method === "POST") {
        const body = await readJsonBody(req);
        const to = asString(body.to);
        const message = asString(body.message);
        const from = asString(body.from) ?? "master";
        if (!to || !message) {
          sendJson(res, 400, { error: "to と message（文字列）は必須です" });
          return true;
        }
        const result = await inject(to, from, message);
        if (to !== BROADCAST_TARGET && result.delivered.length === 0) {
          // 単体宛で配信ゼロ（見つからない/isolated 遮断）は 4xx。
          sendJson(res, 400, { error: result.rejected[0]?.reason ?? "注入に失敗しました", rejected: result.rejected });
          return true;
        }
        sendJson(res, 200, { delivered: result.delivered, rejected: result.rejected, details: result.details });
        return true;
      }

      // ---- POST /control/reverse-inject ----
      // 逆方向通知（エビ → master）。エビ側 MCP の reply_to_master や、サーバ内部の
      // idle 自動通知（B）から叩かれる。to は既定 "master"、from/message は必須。
      // kind は "idle" 指定時のみ idle 扱い、それ以外は "reply"。
      if (pathname === "/control/reverse-inject" && method === "POST") {
        const body = await readJsonBody(req);
        const from = asString(body.from);
        const to = asString(body.to) || "master";
        const message = asString(body.message);
        const kind = asString(body.kind) === "idle" ? "idle" : "reply";
        if (!from || !message) {
          sendJson(res, 400, { error: "from と message（文字列）は必須です" });
          return true;
        }
        const result = await registry.reverseInject(from, to, message, kind);
        if (result.delivered.length === 0) {
          // 宛先なし/isolated/自己送信などで配信ゼロは 4xx で理由を返す。
          sendJson(res, 400, { error: result.rejected[0]?.reason ?? "逆方向通知に失敗しました", rejected: result.rejected });
          return true;
        }
        sendJson(res, 200, { delivered: result.delivered, rejected: result.rejected, details: result.details });
        return true;
      }

      // ---- POST /control/send ----
      // 統一送信。送信先が無ければ（spawnIfMissing 時）spawn し、ready まで待ってから
      // 確実に送信する。既存エビにも使える（その場合は ready 即時→送信）。
      if (pathname === "/control/send" && method === "POST") {
        const body = await readJsonBody(req);
        const to = asString(body.to);
        const message = asString(body.message);
        if (!to || !message) {
          sendJson(res, 400, { error: "to と message（文字列）は必須です" });
          return true;
        }
        const result = await sendMessage({
          to,
          message,
          from: asString(body.from),
          spawnIfMissing: asBool(body.spawnIfMissing),
          model: asString(body.model) ?? undefined,
          cwd: asString(body.cwd),
          useWorktree: asBool(body.useWorktree),
          repoPath: asString(body.repoPath),
          branch: asString(body.branch),
          role: asString(body.role),
          asEngineer: asBool(body.asEngineer),
        });
        if (result.ok) {
          sendJson(res, 200, { ok: true, id: result.id, spawned: result.spawned, status: result.status });
        } else {
          // not found / ready timeout 等は 400 で error と spawned を返す。
          sendJson(res, 400, { ok: false, error: result.error, spawned: result.spawned });
        }
        return true;
      }

      // ---- POST /control/summarize ----
      // 対象エビの直近をワンショット要約エンジン（claude --print --model haiku）で要約し、
      // { id, text } を返す。ask_supervisor（制御MCP）の本実装が呼ぶ。
      if (pathname === "/control/summarize" && method === "POST") {
        const body = await readJsonBody(req);
        const id = asString(body.id);
        if (!id) {
          sendJson(res, 400, { error: "id（文字列）は必須です" });
          return true;
        }
        if (!registry.has(id)) {
          sendJson(res, 404, { error: `agent が見つかりません: ${id}` });
          return true;
        }
        const result = await summarize(id);
        if (result.ok) {
          sendJson(res, 200, { id, text: result.text });
        } else {
          // 要約不能（claude 無し / 出力極小 / 失敗）は理由を 400 で返す。
          sendJson(res, 400, { error: result.reason });
        }
        return true;
      }

      // ---- GET /control/subscribe?id=...&timeoutMs=... ----
      // notification 注入方式の long-poll 購読。制御MCP ブリッジ（起動時に一度だけ）から
      // 継続的に呼ばれる。pending があれば即座に、無ければ timeoutMs（既定 25s、上限 60s）
      // 待って空配列（再接続の合図）を返す。id は agent の存在有無に関わらず受理する
      // （ブリッジは agent 本体より僅かに遅れて起動しうるため、存在チェックはしない）。
      if (pathname === "/control/subscribe" && method === "GET") {
        const id = query.get("id");
        if (!id) {
          sendJson(res, 400, { error: "クエリ id は必須です" });
          return true;
        }
        const timeoutRaw = Number(query.get("timeoutMs"));
        const timeoutMs =
          Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(Math.max(timeoutRaw, 1000), 60000) : 25000;
        const messages = await subscribe(id, timeoutMs);
        sendJson(res, 200, { messages });
        return true;
      }

      // ---- POST /control/ack ----
      // notification 到達確認（end-to-end ACK）。制御MCP ブリッジ（src/mcp/control-server.ts）が
      // subscribe で受け取ったメッセージを notifications/claude/channel として emit した「後」に、
      // その seq id 群（body.ids）を返す。deliver() 側の waitForAck を解決し、これが取れないと
      // deliver は PTY 注入へフォールバックする（黙って消えるのを防ぐ肝）。
      if (pathname === "/control/ack" && method === "POST") {
        const body = await readJsonBody(req);
        const id = asString(body.id);
        const idsRaw = Array.isArray(body.ids) ? body.ids : [];
        const ids = idsRaw.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
        if (!id) {
          sendJson(res, 400, { error: "id（文字列）は必須です" });
          return true;
        }
        registry.ackDelivery(id, ids);
        sendJson(res, 200, { ok: true, acked: ids.length });
        return true;
      }

      // ---- GET /control/pending ----
      // pending（未回収）メッセージの可視化。黙って消えていないことを master / 運用者が観測する入口。
      if (pathname === "/control/pending" && method === "GET") {
        sendJson(res, 200, { pending: registry.pendingSnapshot() });
        return true;
      }

      // ---- GET /control/scrollback?id=...&tail=... ----
      if (pathname === "/control/scrollback" && method === "GET") {
        const id = query.get("id");
        if (!id) {
          sendJson(res, 400, { error: "クエリ id は必須です" });
          return true;
        }
        const agent = registry.get(id);
        if (!agent) {
          sendJson(res, 404, { error: `agent が見つかりません: ${id}` });
          return true;
        }
        let data = agent.getScrollback();
        const tailRaw = query.get("tail");
        if (tailRaw) {
          const tail = Number(tailRaw);
          if (Number.isFinite(tail) && tail > 0 && data.length > tail) {
            // 末尾 N 文字を返す（master が直近の進捗だけ読むため）。
            data = data.slice(-tail);
          }
        }
        sendJson(res, 200, { id, data });
        return true;
      }

      // ---- POST /control/setMode ----
      if (pathname === "/control/setMode" && method === "POST") {
        const body = await readJsonBody(req);
        const id = asString(body.id);
        const mode = asString(body.mode);
        if (!id || (mode !== "connected" && mode !== "isolated")) {
          sendJson(res, 400, { error: "id と mode（connected|isolated）は必須です" });
          return true;
        }
        const ok = registry.setMode(id, mode as AgentMode);
        if (!ok) {
          sendJson(res, 404, { error: `agent が見つかりません: ${id}` });
          return true;
        }
        broadcastRegistry();
        sendJson(res, 200, { id, mode });
        return true;
      }

      // ---- POST /control/kill ---- (dynamic のみ。pinned は 4xx)
      if (pathname === "/control/kill" && method === "POST") {
        const body = await readJsonBody(req);
        const id = asString(body.id);
        if (!id) {
          sendJson(res, 400, { error: "id は必須です" });
          return true;
        }
        if (!registry.has(id)) {
          sendJson(res, 404, { error: `agent が見つかりません: ${id}` });
          return true;
        }
        if (registry.isPinned(id)) {
          sendJson(res, 400, { error: `固定エビ（master/supervisor）は kill できません: ${id}` });
          return true;
        }
        const ok = registry.remove(id);
        broadcastRegistry();
        sendJson(res, ok ? 200 : 500, ok ? { id, killed: true } : { error: "kill に失敗しました" });
        return true;
      }

      // 該当なし。
      sendJson(res, 404, { error: `未知の制御エンドポイント: ${method} ${pathname}` });
      return true;
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
      return true;
    }
  };
}
