// CodexHeadlessBrain — `codex app-server`（JSON-RPC 2.0 / stdio）を master 頭脳にするアダプタ。
//
// **PR-M1 では stub（interface と capabilities のみ）**。実装は PR-M8。
// ここに置くのは「射影表の SoT を型で持っておく」ためで、未実装 id を黙って claude へ
// 落とさないための明示エラーも兼ねる。
//
// ボス裁定（2026-09-05・Q-1）: **codex も master 頭脳の対象に入れる。ただし既定は claude で、
// 規約グレーの点は docs に明記する**。
//
// 規約（原文・docs にも同文を載せる）:
//   "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs."
//   https://developers.openai.com/codex/auth （→ https://learn.chatgpt.com/docs/auth へ 308）
// ChatGPT サブスク資格情報での**ヘッドレス常駐は公式の推奨から外れる**（禁止条項ではない）。
// また `codex app-server` は `--help` 上で `[experimental]`（0.146.0 実測）＝プロトコルの
// 破壊的変更を織り込むこと。したがって `brain: "codex"` を**明示指定したときだけ**有効な opt-in にする。
//
// PoC（§3 / §5-J）で判明済みの実装メモ（PR-M8 が使う）:
//  - `turn/start` の `input` は**配列**（`{items:[...]}` は -32600）。
//  - `turn/steer` は `expectedTurnId` 必須。走行中の割り込みはこれで行う。
//  - item は `item.type`（`item_type` ではない）。最終回答は `agentMessage` かつ
//    `phase === "final_answer"`（途中経過は `phase: "commentary"`）。
//  - 文脈占有量は `thread/tokenUsage/updated` の **`last.inputTokens`**。
//    `total` はスレッド累計で文脈ではない（claude の result.usage と同型の罠）。
//    **窓サイズは通知に含まれない**ので、モデル別テーブルを別途持つ必要がある。
//  - `account/rateLimits/updated` で 5h / 週次の枠使用率と planType が取れる（claude には無い）。
//  - MCP は既存 `toCodexConfigArgs()` / `toCodexProjectsTrustArgs()` がそのまま流用できる。
//    `default_tools_approval_mode="approve"` が無いとツール呼び出しのたびに承認で止まる。

import {
  MasterBrainNotImplementedError,
  unsupportedOf,
  type MasterBrain,
  type MasterBrainCapabilities,
  type MasterBrainInput,
  type MasterBrainStartOptions,
  type MasterEvent,
} from "./brain.ts";

/**
 * codex 頭脳の capabilities（設計書 §3.2 の射影表 codex 列 + PoC §3 の実測）。
 * `askUserQuestion` は相当機能が無く（`mcpServer/elicitation/request` は MCP 由来のみ）、
 * `contextPct` は窓サイズが通知に無いため「モデル別テーブルを持たない限り出せない」= false。
 */
export const CODEX_BRAIN_CAPABILITIES: MasterBrainCapabilities = {
  partialText: true,
  thinking: false,
  permissionPrompt: true,
  askUserQuestion: false,
  interrupt: true,
  resume: true,
  cost: false,
  contextPct: false,
  images: true,
};

/** PR-M8 まではすべてのメソッドが明示エラーを投げる stub。 */
export class CodexHeadlessBrain implements MasterBrain {
  readonly id = "codex" as const;
  readonly capabilities = CODEX_BRAIN_CAPABILITIES;
  readonly unsupported = unsupportedOf(CODEX_BRAIN_CAPABILITIES);
  /** 未起動（stub なので常に null）。 */
  readonly pid = null;

  start(_opts: MasterBrainStartOptions): Promise<void> {
    return Promise.reject(new MasterBrainNotImplementedError("codex", "start"));
  }
  send(_input: MasterBrainInput): Promise<{ acked: boolean }> {
    return Promise.reject(new MasterBrainNotImplementedError("codex", "send"));
  }
  events(): AsyncIterable<MasterEvent> {
    throw new MasterBrainNotImplementedError("codex", "events");
  }
  answer(_id: string, _decision: { allow?: boolean; choice?: string[] }): Promise<void> {
    return Promise.reject(new MasterBrainNotImplementedError("codex", "answer"));
  }
  interrupt(): Promise<void> {
    return Promise.reject(new MasterBrainNotImplementedError("codex", "interrupt"));
  }
  sessionId(): string | null {
    return null;
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
}
