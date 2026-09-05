// 動的エビ(dynamic)に着せる「役割(role)」の定義を一元管理するレジストリ。
//
// 設計方針:
// - 役割ごとの差分は「①system prompt ②MCP ロール ③permissionMode ④既定モデル」の
//   4 点に集約される。これを 1 箇所（EBI_ROLES）にまとめ、「役割追加 = EBI_ROLES に
//   1 エントリ追加」で済む形にする。
// - kind（AgentKind）は増やさない。役割付きの動的エビも kind:"dynamic" のまま。
//   台帳表示用に AgentRecord.role を別途持たせる（protocol.ts）。
// - 公開リポジトリには汎用の役割（engineer = 素のエージェント制御）だけを BUILTIN_ROLES として
//   同梱する。自分専用の役割（特定のワークフロー・ディレクトリ構成・文体等に紐づくプロンプト）を
//   追加したい場合は、コードを触らず ebi-team.config.json の top-level "roles" に定義を書けば、
//   起動時に registerCustomRoles() が検証してこのレジストリへマージする（v1.1）。
//   （fixedEbi の appendSystemPrompt 同様、長文・個人運用向けの文面はコード直書きを避け、
//   config ファイル等リポジトリにコミットしない場所から読み込む形にするのを推奨）。
//
// import 注意: このファイルは MCP 側（src/mcp/control-server.ts）と サーバ側
// （src/server/index.ts）の双方から読まれる。ランタイム依存を増やさないため、
// config.ts からは permissionMode 検証まわりの軽量な定数/関数のみ import する
// （Node 組込みモジュールのみに依存し、副作用の無い純粋な定数/関数）。

import { DEFAULT_PERMISSION_MODE, validatePermissionMode, type PermissionMode } from "./config.ts";
import {
  backendIdError,
  isImplementedBackendId,
  type BackendId,
} from "./backends/index.ts";

/**
 * 役割 id。spawn 時に role として渡す。
 * 組込みは "engineer" のみだが、ebi-team.config.json の roles でカスタム役割 id を
 * 自由に追加できるため、型としては実質 string（任意の役割 id）を許容する。
 */
export type EbiRoleId = string;

/**
 * MCP ロール（EBI_MCP_ROLE として子 MCP に伝わる）。動的エビに渡す公開ツールセットの
 * 権限ティアを決める。動的エビはすべて "engineer" ティア（reply_to_master + 参照系のみ）で
 * 起動する＝他エビを勝手に spawn/kill/操作できない最小権限。統括役の master だけが spawn/
 * kill/send 等のフル制御ツールを持つが、それは固定エビ側の別経路（master-control.mcp.json）
 * で与えるため、この「動的エビ用ティア」の型には含めない。カスタム役割を追加する場合も
 * mcpRole は "engineer" のみ許容する（唯一の権限ティア。未指定なら "engineer" 既定）。
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
  /**
   * 役割ごとの既定バックエンド（PR-E）。未指定なら「config.defaultBackend → env EBI_BACKEND
   * → claude」へフォールバックする。
   * 注意: defaultModel の語彙はバックエンドごとに別物（claude の "opus" は codex では通らない）
   * ため、defaultModel は **この backend で spawn したときだけ**適用される（index.ts の spawnAgent）。
   */
  backend?: BackendId;
  /**
   * この役割で spawn したときの ACK 監視窓（ms）の上書き。未指定なら backend 既定
   * （codex は 90 秒）。0 を指定すると監視そのものを行わない。
   *
   * 効かせる理由（imagegen 役割・設計 §6.4）: codex の ACK 監視は役割プロンプト注入から
   * 90 秒。1 枚 76 秒かかる画像生成タスクが ACK の busy を跨いで注入されると、**正しい失敗報告**
   * が監視窓の内側に落ちて「静かな故障」と誤判定され、無駄な作り直しが走る。実測の ACK 所要は
   * 30 秒前後なので、生成が長い役割だけ窓を短くして重なりを断つ。
   * ackFailureWatch を持たない backend（claude / gemini）では無視される＝挙動不変。
   */
  ackWatchMs?: number;
}

/**
 * 「必要な画像は自分で作らず、imagegen_job(YAML) にして master へ渡す」節。
 * engineer 役割プロンプトの末尾に足す（設計 §2.3）。master は届いた YAML を imagegen エビへ
 * **転記するだけ**で済む。様式の SoT は src/server/imagegen.ts。
 */
export const IMAGE_REQUEST_APPEND =
  "実装に画像素材（アイコン・イラスト・ヒーロー画像等）が必要になった場合、自分で画像を作ろうとしないこと。" +
  "必要な画像を洗い出し、reply_to_master の本文末尾に次の YAML ブロックを 1 個だけ付けて master に渡す" +
  "（master がそのまま imagegen エビへ転記する）: " +
  "imagegen_job: v1 / job_id: <英数と-> / requester: <自分のid> / " +
  "images: の下に - id / purpose / prompt / count / size(WxH または none) / fit(contain|none) / format(png|webp) を並べる。" +
  "1 ジョブは合計 6 枚まで。prompt は日本語で、被写体・背景色・画風・禁止事項（文字を入れない等）まで書き切ること。" +
  "画像が不要なタスクではこのブロックを付けない。";

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
  "破壊的操作・外部送信・git push は勝手にしない。" +
  IMAGE_REQUEST_APPEND;

/**
 * 組込みの役割（公開リポジトリに同梱される既定セット）。常にレジストリに存在する
 * （config のカスタム役割による同名上書きは許可するが、削除はさせない＝EBI_ROLES から
 * キーを消す操作は registerCustomRoles を含めどこにも実装しない）。
 */
export const BUILTIN_ROLES: Record<string, EbiRole> = {
  engineer: {
    id: "engineer",
    label: "エンジニア",
    emoji: "🛠",
    mcpRole: "engineer",
    permissionMode: "bypassPermissions",
    // 既定は明示ID運用（"opus" などのエイリアスは CLI 版依存で解決先が変わるため）。
    defaultModel: "claude-opus-5",
    // 実装役の既定は claude 固定（PR-E 時点。codex/gemini は明示指定 or カスタム役割で使う）。
    backend: "claude",
    appendSystemPrompt: ENGINEER_APPEND_SYSTEM_PROMPT,
  },
};

/**
 * 役割レジストリ。BUILTIN_ROLES を初期値に持ち、起動時（サーバが spawn 要求を処理する前）に
 * registerCustomRoles() で ebi-team.config.json 由来のカスタム役割をマージしうる可変レジストリ。
 * 役割追加はここに直接足すのではなく、config の roles か BUILTIN_ROLES を編集する形にする。
 * 参照側（index.ts / control-server.ts 等）は同一オブジェクト参照を import するため、
 * マージ後の内容がそのまま見える（Object.keys(EBI_ROLES) 等も動的に反映される）。
 */
export const EBI_ROLES: Record<string, EbiRole> = { ...BUILTIN_ROLES };

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

/**
 * 現在レジストリに載っている役割 id 一覧（登録順）。
 * config の roles をマージした後に呼べば、カスタム役割もそのまま含まれる。
 */
export function availableRoleIds(): EbiRoleId[] {
  return Object.keys(EBI_ROLES);
}

/**
 * 未知の役割を弾くときの共通エラー。**必ず利用可能な役割名を列挙する**
 * （master が「では何なら通るのか」を推測しなくて済むようにするため）。
 */
export function unknownRoleError(roleId: string): Error {
  return new Error(`role が不正です: ${roleId}（許容: ${availableRoleIds().join(", ")}）`);
}

// ===== カスタム役割の登録（v1.1: ebi-team.config.json の top-level "roles"） =====

/** カスタム役割で emoji/label が省略されたときの既定値。 */
const CUSTOM_ROLE_DEFAULT_EMOJI = "🧩";
/** カスタム役割で defaultModel が省略されたときの既定値（安価寄りを既定にする）。 */
const CUSTOM_ROLE_DEFAULT_MODEL = "sonnet";

/** raw なフィールド値を文字列として検証する。未指定は undefined、型不正は throw。 */
function asOptionalString(v: unknown, field: string, roleId: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw new Error(`カスタム役割 "${roleId}" の ${field} は文字列である必要があります`);
  }
  return v;
}

/** raw なフィールド値を 0 以上の整数として検証する。未指定は undefined、型不正は throw。 */
function asOptionalNonNegativeInt(v: unknown, field: string, roleId: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new Error(`カスタム役割 "${roleId}" の ${field} は 0 以上の整数である必要があります`);
  }
  return v;
}

/**
 * 1 件の生ロール定義（config.roles[id]）を検証・正規化する。
 * 不正な形（オブジェクトでない・型が違う・mcpRole が engineer 以外 等）は明確な Error を throw する。
 */
function normalizeCustomRole(id: string, raw: unknown): EbiRole {
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error(`カスタム役割の id が不正です: ${String(id)}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`カスタム役割 "${id}" の定義はオブジェクトである必要があります`);
  }
  const r = raw as Record<string, unknown>;

  const label = asOptionalString(r.label, "label", id) ?? id;
  const emoji = asOptionalString(r.emoji, "emoji", id) ?? CUSTOM_ROLE_DEFAULT_EMOJI;

  const mcpRoleRaw = asOptionalString(r.mcpRole, "mcpRole", id) ?? "engineer";
  if (mcpRoleRaw !== "engineer") {
    throw new Error(
      `カスタム役割 "${id}" の mcpRole が不正です: ${mcpRoleRaw}（許容: "engineer" のみ。` +
        `これが動的エビに与える唯一の権限ティア）`,
    );
  }
  const mcpRole: EbiMcpRole = "engineer";

  const permissionModeRaw = asOptionalString(r.permissionMode, "permissionMode", id);
  let permissionMode: PermissionMode;
  if (permissionModeRaw === undefined) {
    permissionMode = DEFAULT_PERMISSION_MODE;
  } else {
    try {
      permissionMode = validatePermissionMode(permissionModeRaw);
    } catch (err) {
      throw new Error(`カスタム役割 "${id}" の ${(err as Error).message}`);
    }
  }

  const backendRaw = asOptionalString(r.backend, "backend", id);
  let backend: BackendId | undefined;
  if (backendRaw !== undefined) {
    if (!isImplementedBackendId(backendRaw)) {
      throw new Error(`カスタム役割 "${id}" の ${backendIdError(backendRaw).message}`);
    }
    backend = backendRaw;
  }

  // defaultModel の既定はバックエンドで変わる。claude 以外は CLI 既定モデルに任せる
  //（claude 語彙の "sonnet" を codex/gemini に渡すと毎ターン 400 になる）。
  const ackWatchMs = asOptionalNonNegativeInt(r.ackWatchMs, "ackWatchMs", id);

  const defaultModel =
    asOptionalString(r.defaultModel, "defaultModel", id) ??
    (backend === undefined || backend === "claude" ? CUSTOM_ROLE_DEFAULT_MODEL : "");
  const appendSystemPrompt = asOptionalString(r.appendSystemPrompt, "appendSystemPrompt", id) ?? "";

  return {
    id,
    label,
    emoji,
    mcpRole,
    permissionMode,
    defaultModel,
    backend,
    appendSystemPrompt,
    ...(ackWatchMs === undefined ? {} : { ackWatchMs }),
  };
}

/**
 * ebi-team.config.json の top-level "roles"（{ [id]: RoleDef }）を検証し、EBI_ROLES レジストリへ
 * マージする。
 * - サーバ（index.ts）・master 用 MCP ブリッジ（control-server.ts）の双方で、spawn 要求 /
 *   ツール呼び出しを処理する前に呼ぶこと。
 * - raw が undefined/null なら何もしない（後方互換: roles 未指定＝engineer のみ）。
 * - 組込み engineer は config で同名キーを与えれば上書きできるが、削除はできない
 *   （この関数は EBI_ROLES への追加/上書きのみ行い、既存キーを消さない）。
 * - 不正な形は Error を throw する。呼び出し側で catch し、警告ログのみで起動を継続する
 *   運用を想定する（fixedEbi の config 読み込み失敗時と同じ方針）。
 */
export function registerCustomRoles(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`ebi-team.config.json の roles はオブジェクト（{ 役割id: 定義 }）である必要があります`);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  const normalized = entries.map(([id, def]) => normalizeCustomRole(id, def));
  for (const role of normalized) {
    EBI_ROLES[role.id] = role;
  }
}
