// MasterBrain 抽象 — 「多ターン会話プロセスの制御」のバックエンド非依存インターフェース。
//
// 設計書: docs/design/master-chat-ui-2026-09-05.md §3（r2）
// 実測:   docs/poc/master-headless-poc-2026-09-05.md（PR-M0）
//
// 設計方針:
// - 既存の EbiBackend（backends/types.ts）とは**別物**。あちらは「PTY 起動引数の組み立て」、
//   こちらは「stdin/stdout で多ターン会話を回すプロセスの制御」。同居させると両方壊れるので
//   インターフェースを分け、共有するのは ControlMcpSpec（中立表現）だけにする。
// - このファイルは **node 組込みに依存しない純粋な型/定数のみ**（backends/types.ts と同じ制約）。
//   実プロセスを起動する実装は claudeBrain.ts 側に閉じる。
// - PR-M1 の範囲はサーバ内部まで。UI 配線（WS プロトコル・MasterSession）は PR-M2。

import type { ControlMcpSpec, PermissionMode } from "../backends/types.ts";
import type {
  MasterAnswer,
  MasterPermissionDecision,
  MasterPermissionRequest,
  PermissionOutcome,
} from "./permission.ts";

/** master の頭脳として使える CLI の識別子。 */
export type MasterBrainId = "claude" | "codex" | "gemini" | "agy";

/** master 頭脳として config に書ける id の全集合（値域検証の SoT）。 */
export const MASTER_BRAIN_IDS: readonly MasterBrainId[] = ["claude", "codex", "gemini", "agy"];

/**
 * 実装済みの MasterBrain（未実装 id を黙って claude に落とさないための SoT）。
 * PR-M1 時点では claude のみ。codex は interface + stub まで（ボス裁定 Q-1 の opt-in・PR-M8 で実装）。
 * gemini は対象外（ボス裁定 Q-2）、agy は保留。
 */
export const IMPLEMENTED_MASTER_BRAIN_IDS: readonly MasterBrainId[] = ["claude"];

/** master の既定頭脳。config で `brain` 未指定ならこれ（ボス裁定 Q-1: 既定は claude）。 */
export const DEFAULT_MASTER_BRAIN_ID: MasterBrainId = "claude";

export interface MasterBrainStartOptions {
  /** 作業ディレクトリ。 */
  cwd: string;
  /**
   * 起動モデル。null なら backend の既定を使う。
   * claude では null を渡さないこと: **CLI の既定モデルは opus ではない**（PoC 実測 §5-H で
   * `claude-fable-5-1` だった）。claudeArgs.ts が DEFAULT_CLAUDE_MASTER_MODEL を補う。
   */
  model: string | null;
  /** 抽象 permissionMode（PERMISSION_MODES を再利用）。master 既定は auto（ボス裁定 Q-5）。 */
  permissionMode: PermissionMode | null;
  /** 役割プロンプト（現行 fixedEbi[].appendSystemPrompt 相当）。 */
  systemPrompt: string | null;
  /** 制御MCP の中立表現（方言への射影は backends/mcpSpec.ts）。 */
  controlMcp: ControlMcpSpec | null;
  /** claude 方言の `--mcp-config` に渡す JSON ファイルパス（既存 .ebi-team/*.mcp.json）。 */
  mcpConfigPath: string | null;
  /** 再開したいセッション id（null なら新規）。 */
  resumeSessionId: string | null;
  /** 追加引数（config の args）。常に末尾へ付く。 */
  extraArgs: readonly string[];
}

/** 文脈・トークンの観測値。 */
export interface MasterUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
  /**
   * 文脈占有トークン数（input + cache_read + cache_creation）。
   * **セッション内で単調増加する値**であること（PoC §2.8）。
   */
  contextTokens: number | null;
  /** 文脈窓（分母）。claude は result.modelUsage[model].contextWindow から取れる。 */
  contextSize: number | null;
  /** 文脈使用率(%)。算出できない backend は null（UI は「—（未対応）」）。 */
  contextUsedPct: number | null;
}

/** UI へ流す正規化イベント（backend 非依存）。 */
export type MasterEvent =
  | {
      kind: "session";
      sessionId: string;
      model: string | null;
      /** `--bare` 回避とサブスク OAuth の自己申告（claude の system/init.apiKeySource）。 */
      apiKeySource: string | null;
      mcpServers: { name: string; status: string }[];
      capabilities: string[];
    }
  /** 投入した user メッセージのプロトコル ACK（claude の --replay-user-messages）。 */
  | { kind: "ack"; text: string }
  | { kind: "text"; text: string; partial: boolean }
  | { kind: "thinking"; text: string; partial: boolean }
  | { kind: "toolCall"; id: string; name: string; input: unknown }
  | { kind: "toolResult"; id: string; ok: boolean; content: string }
  | { kind: "permission"; id: string; toolName: string; input: unknown; suggestions?: string[] }
  | {
      kind: "question";
      id: string;
      header: string;
      question: string;
      options: { label: string; description?: string }[];
      multi: boolean;
    }
  /**
   * 保留（permission / question）1 件が解けた（PR-M5）。
   * UI はこれを見てボタンを畳む。**再接続や再起動のあとでも**トランスクリプトから
   * 決着済みかどうかが復元できるように、notice ではなく専用の kind にしている。
   */
  | { kind: "permissionSettled"; id: string; outcome: PermissionOutcome; answer: string | null }
  | {
      kind: "turnEnd";
      ok: boolean;
      /**
       * ユーザーが中断したターンか。
       * 中断後の result は `is_error:true` / `subtype:"error_during_execution"` /
       * `terminal_reason:"aborted_streaming"` で来る（PoC §2.6）ので、**通常エラー通知に
       * 化けさせないため**の分岐フラグ。true のとき UI は「中断しました」を出す。
       */
      aborted: boolean;
      usage: MasterUsage | null;
      /** このプロセスの累積コスト(USD)。resume で 0 に戻る（PoC §2.9）。 */
      costUsd: number | null;
      /** ok=false かつ aborted=false のときのエラー本文。 */
      errorText: string | null;
    }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string }
  | { kind: "exit"; code: number | null; signal: string | null };

export interface MasterBrainCapabilities {
  partialText: boolean;
  thinking: boolean;
  permissionPrompt: boolean;
  askUserQuestion: boolean;
  interrupt: boolean;
  resume: boolean;
  cost: boolean;
  contextPct: boolean;
  images: boolean;
}

/** 投入する 1 通。 */
export interface MasterBrainInput {
  text: string;
  images?: { mediaType: string; base64: string }[];
}

export interface MasterBrain {
  readonly id: MasterBrainId;
  readonly capabilities: MasterBrainCapabilities;
  /**
   * 起動。
   * resolve は「1 通目を受け付けられる」状態＝**プロセスが立って stdin が書ける**まで。
   * **`system/init` を待ってはいけない**: claude の init は「最初の user メッセージを
   * 受け取ってから」しか出ず、init 待ちで ready 判定するとデッドロックする（PoC §5-A）。
   */
  start(opts: MasterBrainStartOptions): Promise<void>;
  /** ユーザー発話（およびエビからの reply）を投入する。 */
  send(input: MasterBrainInput): Promise<{ acked: boolean }>;
  /** 出力ストリーム（正規化済み）。 */
  events(): AsyncIterable<MasterEvent>;
  /** 承認/質問への応答（permission / question の id に対して返す）。 */
  answer(id: string, decision: MasterAnswer): Promise<void>;
  /**
   * `--permission-prompt-tool`（制御MCP の permission_prompt）から届いた承認要求を受ける。
   * **ボスが答えるまで resolve しない**（未応答は待ち続ける・自動拒否しない）。
   * 承認 UI を持たない backend では未実装（optional）。
   */
  requestPermission?(
    req: MasterPermissionRequest,
    signal?: AbortSignal,
  ): Promise<MasterPermissionDecision>;
  /** 未応答の承認/質問の件数（UI のスティッキーバー用）。 */
  readonly pendingPermissions?: number;
  /**
   * 未応答の承認/質問の id 一覧（＝ブローカの台帳そのもの）。
   * 「UI には残っているがブローカにはもう無い」孤児を洗い出す再同期に使う。
   */
  readonly pendingPermissionIds?: readonly string[];
  /** 実行中ターンの中断（会話は殺さない）。 */
  interrupt(): Promise<void>;
  /** 再開に必要な id（プロセス死亡後の resume 用に呼び出し側が永続化する）。 */
  sessionId(): string | null;
  /** 子プロセスの pid（未起動なら null）。registry 表示に使う。 */
  readonly pid: number | null;
  /** 終了。 */
  stop(): Promise<void>;
  /** この backend が実装できない機能（UI が事前に灰色表示するため）。 */
  readonly unsupported: readonly (keyof MasterBrainCapabilities)[];
}

/** capabilities から unsupported（false のキー）を導出する純関数。二重管理を作らない。 */
export function unsupportedOf(
  caps: MasterBrainCapabilities,
): (keyof MasterBrainCapabilities)[] {
  return (Object.keys(caps) as (keyof MasterBrainCapabilities)[]).filter((k) => !caps[k]);
}

/** 未実装 backend を触ったときのエラー（黙って claude に落とさない）。 */
export class MasterBrainNotImplementedError extends Error {
  constructor(
    readonly brainId: MasterBrainId,
    what: string,
  ) {
    super(`MasterBrain "${brainId}" は未実装です（${what}）`);
    this.name = "MasterBrainNotImplementedError";
  }
}

/**
 * プロセスを跨いだコスト累積。
 *
 * claude の `result.total_cost_usd` は **プロセス単位の積算**で、`--resume` で起動し直すと
 * 0 から数え直す（PoC §2.9: run1 が $0.2478 まで伸びた後、resume 直後の run2 は $0.0189）。
 * したがって「会話としての累計」はサーバ側でプロセスを跨いで足す必要がある。
 * 各プロセスの**最新値**を覚えて合計するだけの純粋なレジャ（加算ではなく上書き→総和）。
 */
export class MasterCostLedger {
  private readonly perProcess = new Map<string, number>();

  /** プロセス key の最新 total_cost_usd を記録する（null は無視）。 */
  noteProcessTotal(processKey: string, totalUsd: number | null): void {
    if (totalUsd == null || !Number.isFinite(totalUsd)) return;
    this.perProcess.set(processKey, totalUsd);
  }

  /** 会話としての累計(USD)。 */
  total(): number {
    let sum = 0;
    for (const v of this.perProcess.values()) sum += v;
    return sum;
  }

  /**
   * 記録を全部捨てる（「新しい会話」で会話単位の累計を 0 に戻すため）。
   * プロセス跨ぎの累計は「1 つの会話の累計」なので、会話を切ったらここも切る。
   */
  reset(): void {
    this.perProcess.clear();
  }

  /** 記録済みプロセス数（デバッグ・テスト用）。 */
  get processCount(): number {
    return this.perProcess.size;
  }
}
