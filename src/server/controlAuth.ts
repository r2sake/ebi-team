// セキュアモードの制御 API 認証（エビごとの個別トークン＋サーバ側の役割検証）。
//
// standard では使わない（loopback は従来どおり無認証）。secure では:
// - サーバが spawn のたびにエビごとのトークンを発行し、pty env の EBI_CONTROL_TOKEN で渡す
//   （制御 MCP・hook が `x-ebi-control-token` ヘッダで送る）
// - トークンの役割でエンドポイントを絞る。engineer のトークンでは /control/spawn・/control/inject・
//   /control/send・/control/kill などを拒否する（エビが自分で仲間を起こしたり、他のエビへ
//   指示を差し込んだりできないようにする）
// - engineer は「自分の id」でしか購読・ACK・reply_to_master できない（なりすまし防止）
// - ボスが config で足した固定エビ（minaebi 等・範囲外）には "fixed"（全許可＝今のまま）を発行する
//
// 純関数（判定）と小さなストア（発行・照合）だけを置く。HTTP の配線は index.ts / control.ts。

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** トークンの役割。 */
export type ControlTokenRole = "master" | "engineer" | "fixed";

export interface ControlCaller {
  agentId: string;
  role: ControlTokenRole;
}

/** engineer のトークンで呼べるもの（制御 MCP の engineer 向けツール＋配送の足回り＋承認の受け口）。 */
const ENGINEER_ALLOWED: ReadonlySet<string> = new Set([
  "GET /control/agents", // list_ebi
  "GET /control/scrollback", // read_scrollback
  "POST /control/reverse-inject", // reply_to_master
  "GET /control/subscribe", // 通知の購読
  "POST /control/ack", // 通知の到達確認
  "GET /control/pending",
  "POST /control/usage", // statusLine
  "POST /control/secure-approval", // hook（git push・権限の確認をボスへ回す）
]);

/** トークン無しでも通すもの（statusLine はボスの手元スクリプトでトークンを送れないため）。 */
const PUBLIC_ALLOWED: ReadonlySet<string> = new Set(["POST /control/usage"]);

/** ボスのブラウザ（同一オリジン）からトークン無しで来てよいもの（画像表示・添付）。 */
const BROWSER_ALLOWED: ReadonlySet<string> = new Set([
  "GET /control/viewer-file",
  "GET /control/chat-attachment",
  "POST /control/chat-attach",
]);

export type ControlAccessVerdict = { ok: true } | { ok: false; status: 401 | 403; error: string };

/**
 * secure の制御 API の可否（純関数）。
 * @param remoteAuthed 非 loopback で EBI_AUTH_TOKEN 認証を通った（＝ボスのリモート UI / API）
 * @param browser 同一オリジンのブラウザから来た（Origin / Sec-Fetch-Site が same-origin）
 */
export function decideSecureControlAccess(input: {
  method: string;
  pathname: string;
  caller: ControlCaller | null;
  browser: boolean;
  remoteAuthed: boolean;
}): ControlAccessVerdict {
  const key = `${input.method.toUpperCase()} ${input.pathname}`;
  if (input.remoteAuthed) return { ok: true };
  if (input.caller) {
    if (input.caller.role === "master" || input.caller.role === "fixed") return { ok: true };
    if (ENGINEER_ALLOWED.has(key)) return { ok: true };
    return {
      ok: false,
      status: 403,
      error: `セキュアモード: ${input.caller.agentId}（engineer）のトークンでは ${key} は使えません`,
    };
  }
  if (PUBLIC_ALLOWED.has(key)) return { ok: true };
  if (input.browser && BROWSER_ALLOWED.has(key)) return { ok: true };
  return { ok: false, status: 401, error: "セキュアモード: 制御 API にはエビごとのトークンが必要です" };
}

/** engineer が「自分以外の id」を名乗っていないか（なりすまし防止）。master / fixed は対象外。 */
export function callerMayActAs(caller: ControlCaller | null, id: string | null | undefined): boolean {
  if (!caller || caller.role !== "engineer") return true;
  return id === caller.agentId;
}

/** トークンの発行・照合（プロセス内メモリ。サーバ再起動で全部入れ替わる）。 */
export class ControlTokenStore {
  private readonly byAgent = new Map<string, { token: string; role: ControlTokenRole }>();

  /** 発行（同じ id に再発行すると古いトークンは無効になる）。 */
  issue(agentId: string, role: ControlTokenRole): string {
    const token = randomBytes(24).toString("base64url");
    this.byAgent.set(agentId, { token, role });
    return token;
  }

  revoke(agentId: string): void {
    this.byAgent.delete(agentId);
  }

  /** 照合（定数時間比較）。見つからなければ null。 */
  resolve(token: string | null | undefined): ControlCaller | null {
    if (!token) return null;
    const provided = Buffer.from(token);
    for (const [agentId, entry] of this.byAgent) {
      const expected = Buffer.from(entry.token);
      if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
        return { agentId, role: entry.role };
      }
    }
    return null;
  }
}

// 認証ゲート（index.ts）で照合した呼び出し元を、制御 API の各ハンドラ（control.ts）へ渡す。
const callers = new WeakMap<IncomingMessage, ControlCaller>();

export function setControlCaller(req: IncomingMessage, caller: ControlCaller): void {
  callers.set(req, caller);
}

export function getControlCaller(req: IncomingMessage): ControlCaller | null {
  return callers.get(req) ?? null;
}
