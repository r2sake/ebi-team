// 動的エビ(dynamic)に着せる「役割(role)」の定義を一元管理するレジストリ。
//
// 設計方針:
// - 役割ごとの差分は「①system prompt ②MCP ロール ③permissionMode ④既定モデル」の
//   4 点に集約される。これを 1 箇所（EBI_ROLES）にまとめ、「役割追加 = EBI_ROLES に
//   1 エントリ追加」で済む形にする。
// - kind（AgentKind）は増やさない。役割付きの動的エビも kind:"dynamic" のまま。
//   台帳表示用に AgentRecord.role を別途持たせる（protocol.ts）。
// - 公開リポジトリには汎用の役割（engineer = 素のエージェント制御）だけを同梱する。
//   自分専用の役割（特定のワークフロー・ディレクトリ構成・文体等に紐づくプロンプト）を
//   追加したい場合は、下記 EBI_ROLES にエントリを追加してカスタマイズしてください
//   （fixedEbi の appendSystemPrompt 同様、長文・個人運用向けの文面はコード直書きを避け、
//   env や config ファイル等リポジトリにコミットしない場所から読み込む形にするのを推奨）。
//
// import 注意: このファイルは MCP 側（src/mcp/control-server.ts）と サーバ側
// （src/server/index.ts）の双方から読まれる。ランタイム依存を増やさないため、
// PermissionMode は型のみ import する。

import type { PermissionMode } from "./config.ts";

/**
 * 役割 id。spawn 時に role として渡す。
 * 既定では汎用の "engineer" のみを同梱する。カスタム役割を増やす場合はここに
 * ユニオン型で id を追加し、下の EBI_ROLES にも対応エントリを追加する。
 */
export type EbiRoleId = "engineer";

/**
 * MCP ロール（EBI_MCP_ROLE として子 MCP に伝わる）。動的エビに渡す公開ツールセットの
 * 権限ティアを決める。動的エビはすべて "engineer" ティア（reply_to_master + 参照系のみ）で
 * 起動する＝他エビを勝手に spawn/kill/操作できない最小権限。統括役の master だけが spawn/
 * kill/send 等のフル制御ツールを持つが、それは固定エビ側の別経路（master-control.mcp.json）
 * で与えるため、この「動的エビ用ティア」の型には含めない。カスタム役割を追加する場合も
 * mcpRole は "engineer" を指定すればこの最小権限ティアを流用できる。
 */
export type EbiMcpRole = "engineer";

/** 動的エビの役割定義。 */
export interface EbiRole {
  /** 役割 id。spawn 時に role として渡す。 */
  id: EbiRoleId;
  /** UI 表示名（バッジ用）。 */
  label: string;
  /** UI バッジ絵文字。 */
  emoji: string;
  /** --append-system-prompt に渡す役割注入プロンプト。 */
  appendSystemPrompt: string;
  /** MCP ロール（EBI_MCP_ROLE）。公開ツールセットを決める。 */
  mcpRole: EbiMcpRole;
  /** 既定 permission-mode。 */
  permissionMode: PermissionMode;
  /** 既定モデル（alias）。 */
  defaultModel: string;
}

/**
 * engineer エビの役割注入（--append-system-prompt）。
 * spawn_engineer / spawn_ebi(role="engineer") / send_message(spawnIfMissing) で
 * 起動する動的エビに付与する、汎用の「使い捨て実装セッション」プロンプト。
 */
export const ENGINEER_APPEND_SYSTEM_PROMPT =
  "あなたはエビチームの engineer エビ。master から委譲された単発タスクを実装する『使い捨てセッション』。" +
  "作業は与えられた cwd/worktree 内で完結させる。" +
  "完了したら必ず reply_to_master ツールで、結論ファーストの簡潔な報告（成果・差分・次アクション）を master に送る" +
  "（master はこれを待っている。scrollback を読ませない＝トークン節約）。報告後は master に kill される前提でよい。" +
  "破壊的操作・外部送信・git push は勝手にしない。";

/**
 * 役割レジストリ。役割追加はここに 1 エントリ足すだけで済む。
 * permissionMode はいずれも bypassPermissions（無人稼働・確認待ちで止めない）。
 * 安全性は cwd/worktree 隔離＋各役割プロンプトの禁止事項で担保する。
 */
export const EBI_ROLES: Record<EbiRoleId, EbiRole> = {
  engineer: {
    id: "engineer",
    label: "エンジニア",
    emoji: "🛠",
    mcpRole: "engineer",
    permissionMode: "bypassPermissions",
    defaultModel: "opus",
    appendSystemPrompt: ENGINEER_APPEND_SYSTEM_PROMPT,
  },
};

/** 役割 id として妥当か（レジストリに存在するか）を検証する型ガード。 */
export function isEbiRoleId(value: string | undefined | null): value is EbiRoleId {
  return value != null && Object.prototype.hasOwnProperty.call(EBI_ROLES, value);
}

/**
 * role 文字列から EbiRole を引く。未知/未指定なら undefined。
 * 後方互換: 呼び出し側で asEngineer=true を role="engineer" に読み替えてから使う。
 */
export function resolveRole(role: string | undefined | null): EbiRole | undefined {
  return isEbiRoleId(role) ? EBI_ROLES[role] : undefined;
}
