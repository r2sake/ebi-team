// セキュアモード（起動時の切り替えでエビの権限を弱くする）。
//
// 目的は **事故防止**（うっかりの git push・本番反映・外部送信・秘密の読み出しを止める）。
// OS のサンドボックスは次の段階で足す（今回は入れない）。
//
// ボス裁定（2026-11-17）:
// - 切り替えは起動フラグ（env EBI_SECURITY_MODE=secure か config の securityMode）。
//   **再起動でのみ切り替わる**。動いているエビを途中で緩めない（実行中に変える口は作らない）。
// - git push・本番の操作は deny ではなく「ボスがチャットで承認すれば通す」。
//   承認はボスの UI 操作だけ（master の MCP から許可を付けられない）。
// - master は例外にせず、止まらないまま同じ禁止リストを足す。
// - minaebi・errwatch などボスが config で足した固定エビ（ユーザが拡張した部分）は範囲外。
//   対象は master / supervisor（固定エビの kind）と、spawnAgent で起こす動的エビだけ。
//
// このファイルは I/O を持たない純関数だけを置く（設定ファイルの書き出しは index.ts）。

import { realpathSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import type { BackendId, PermissionMode } from "./backends/types.ts";

/** セキュリティモード。standard = 従来どおり / secure = 締め付け。 */
export type SecurityMode = "standard" | "secure";

export const SECURITY_MODES: readonly SecurityMode[] = ["standard", "secure"];

export interface ResolvedSecurityMode {
  mode: SecurityMode;
  /** どこで決まったか（ログ用）。 */
  source: "env" | "config" | "default";
  /** 不正値を安全側（secure）へ倒したときの警告。 */
  warning: string | null;
}

/**
 * env > config > 既定（standard）の順でモードを決める純関数。
 * 不正値は **secure に倒す**（打ち間違いで黙って緩い方に落ちるのを避ける）。
 */
export function resolveSecurityMode(opts: {
  env?: string | undefined;
  config?: unknown;
}): ResolvedSecurityMode {
  const pick = (
    raw: unknown,
    source: "env" | "config",
  ): ResolvedSecurityMode | null => {
    if (raw === undefined || raw === null) return null;
    const v = String(raw).trim();
    if (v === "") return null;
    if ((SECURITY_MODES as readonly string[]).includes(v)) {
      return { mode: v as SecurityMode, source, warning: null };
    }
    return {
      mode: "secure",
      source,
      warning: `securityMode の値が不正です（${v}）。安全側の secure で起動します（許容: ${SECURITY_MODES.join(", ")}）`,
    };
  };
  return pick(opts.env, "env") ?? pick(opts.config, "config") ?? {
    mode: "standard",
    source: "default",
    warning: null,
  };
}

// ===== 秘密の env =====

/** 名前そのもので秘密とみなす env。 */
export const SECRET_ENV_KEYS: readonly string[] = ["EBI_AUTH_TOKEN", "DATABASE_URL"];

/** 名前の形で秘密とみなす env。 */
export const SECRET_ENV_PATTERNS: readonly RegExp[] = [
  /^CLOUDFLARE_/,
  /^CF_API_/,
  /_TOKEN$/,
  /_SECRET$/,
  /_SECRET_KEY$/,
  /_SECRET_ACCESS_KEY$/,
  /_API_KEY$/,
  /_PRIVATE_KEY$/,
  /_PASSWORD$/,
  /_PASSWD$/,
  /_PAT$/,
  /_WEBHOOK_URL$/,
  /_DATABASE_URL$/,
];

/**
 * 形は秘密でも **エージェント CLI 自身の起動・認証に要る**ので残す env。
 * これを落とすと claude / codex / gemini が認証できずに起動しない
 * （gemini の GOOGLE_CLOUD_PROJECT 事故と同型の失敗を避ける）。
 * 課金経路の選別（API キーを落とすか）は既存の envDenyList / MASTER_ENV_DENY_LIST の担当。
 */
export const SECRET_ENV_KEEP: readonly string[] = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

export function isSecretEnvKey(key: string): boolean {
  if (SECRET_ENV_KEEP.includes(key)) return false;
  if (SECRET_ENV_KEYS.includes(key)) return true;
  return SECRET_ENV_PATTERNS.some((re) => re.test(key));
}

/** env から秘密の値を抜く純関数。落としたキー名（値は返さない）も返す。 */
export function stripSecretEnv<T extends string | undefined>(
  env: Record<string, T>,
): { env: Record<string, T>; dropped: string[] } {
  const out: Record<string, T> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (isSecretEnvKey(k)) {
      dropped.push(k);
      continue;
    }
    out[k] = v;
  }
  return { env: out, dropped };
}

// ===== permission-mode の既定 =====

/**
 * セキュアモードでの permissionMode の決め方（純関数）。standard では役割既定をそのまま返す。
 *
 * - 明示の要求（制御 API / MCP の permissionMode）はそのまま使う（bypass は clampForSecurity が拒否）
 * - 役割既定が bypassPermissions で、それがボスの config で**明示されていない**（組込み engineer の既定）
 *   なら auto に下げる。auto は実機で権限確認がほぼ出ず（acceptEdits は 7 コマンド中 2 件で確認が出た）、
 *   出た確認は PermissionRequest hook でチャットの承認バブルへ回る
 * - config に bypassPermissions を明示した役割は opt-in として残す
 */
export const SECURE_DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

export function securePermissionMode(
  mode: SecurityMode,
  opts: { requested: PermissionMode | null; roleMode: PermissionMode | null; roleExplicit: boolean; fallback: PermissionMode },
): PermissionMode {
  if (opts.requested) return opts.requested;
  const base = opts.roleMode ?? opts.fallback;
  if (mode !== "secure") return base;
  if (base === "bypassPermissions" && !opts.roleExplicit) return SECURE_DEFAULT_PERMISSION_MODE;
  return base;
}

// ===== 起動引数の締め付け =====

/** secure で拒否する spawn 要求（制御 API / MCP の 400 になる）。 */
export class SecureModeRejection extends Error {
  constructor(message: string) {
    super(`セキュアモードのため起動できません: ${message}`);
    this.name = "SecureModeRejection";
  }
}

/** claude の権限を緩めるフラグ（値を取らない）。 */
const CLAUDE_LOOSENING_FLAGS = ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"];
/** codex の権限を緩めるフラグ（値を取らない）。 */
const CODEX_LOOSENING_FLAGS = ["--dangerously-bypass-approvals-and-sandbox", "--yolo"];
/** gemini の権限を緩めるフラグ（値を取らない）。 */
const GEMINI_LOOSENING_FLAGS = ["--yolo", "-y"];
/** gemini を secure で起こしてよい permissionMode（＝書き込まない役）。 */
const GEMINI_READONLY_MODES: readonly PermissionMode[] = ["plan", "default"];

export interface SecurityClampInput {
  /** 起動する backend。null は bash 等のスタブ起動（引数に何もしない）。 */
  backend: BackendId | null;
  /** 組み立て済みの起動引数（固定エビは config 由来の args、動的エビは buildLaunchArgs の結果）。 */
  args: readonly string[];
  /**
   * 呼び出し元（制御 API / MCP / WS）が**明示した** permissionMode。
   * 緩める指定（bypassPermissions）なら拒否する。役割既定・config 由来はここに入れない。
   */
  requestedPermissionMode?: string | null;
  /** 実際に使う permissionMode（gemini の書き込み役判定に使う）。 */
  permissionMode?: PermissionMode | null;
  /** claude に足す secure 設定ファイル（--settings）。null なら足さない。 */
  settingsPath: string | null;
}

export interface SecurityClampResult {
  args: string[];
  /** 何を変えたか（ログ用）。 */
  notes: string[];
}

function dropFlags(args: readonly string[], flags: readonly string[], notes: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (flags.includes(a)) {
      notes.push(`${a} を外しました`);
      continue;
    }
    out.push(a);
  }
  return out;
}

/** `<flag> <value>` / `<flag>=<value>` の値を書き換える。 */
function rewriteValue(
  args: string[],
  flags: readonly string[],
  shouldRewrite: (v: string) => boolean,
  to: string,
  notes: string[],
): string[] {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    const a = out[i]!;
    for (const f of flags) {
      if (a === f && i + 1 < out.length && shouldRewrite(out[i + 1]!)) {
        notes.push(`${f} ${out[i + 1]} を ${to} に下げました`);
        out[i + 1] = to;
      } else if (a.startsWith(`${f}=`) && shouldRewrite(a.slice(f.length + 1))) {
        notes.push(`${a} を ${f}=${to} に下げました`);
        out[i] = `${f}=${to}`;
      }
    }
  }
  return out;
}

/**
 * セキュアモードの締め付けを 1 か所で行う純関数（spawnAgent・固定エビ・master brain・
 * supervisor の 1 本道）。standard では引数をそのまま返す。
 *
 * - 明示の bypassPermissions 要求 → 拒否（SecureModeRejection）
 * - claude: --dangerously-skip-permissions 等を外し、--settings <secure.json> を足す
 *   （bypassPermissions のままでも settings の deny と hook は効く・2.1.322 で実機確認）
 * - codex: danger-full-access を workspace-write に下げ、bypass 系フラグを外す
 * - gemini: 書き込み役（plan / default 以外）は起こさない。yolo 系フラグは外す
 */
export function clampForSecurity(input: SecurityClampInput, mode: SecurityMode): SecurityClampResult {
  if (mode !== "secure") return { args: [...input.args], notes: [] };
  const notes: string[] = [];

  if (input.requestedPermissionMode === "bypassPermissions") {
    throw new SecureModeRejection("permissionMode=bypassPermissions の指定は受け付けません");
  }

  switch (input.backend) {
    case "claude": {
      const args = dropFlags(input.args, CLAUDE_LOOSENING_FLAGS, notes);
      if (input.settingsPath) args.push("--settings", input.settingsPath);
      return { args, notes };
    }
    case "codex": {
      let args = dropFlags(input.args, CODEX_LOOSENING_FLAGS, notes);
      args = rewriteValue(args, ["-s", "--sandbox"], (v) => v === "danger-full-access", "workspace-write", notes);
      args = rewriteValue(
        args,
        ["-c", "--config"],
        (v) => /^sandbox_mode\s*=/.test(v) && v.includes("danger-full-access"),
        'sandbox_mode="workspace-write"',
        notes,
      );
      return { args, notes };
    }
    case "gemini": {
      const pm = input.permissionMode ?? null;
      if (pm === null || !GEMINI_READONLY_MODES.includes(pm)) {
        throw new SecureModeRejection(
          `gemini は書き込み役（permissionMode=${pm ?? "未指定"}）では起こしません（plan / default のみ）`,
        );
      }
      let args = dropFlags(input.args, GEMINI_LOOSENING_FLAGS, notes);
      args = rewriteValue(args, ["--approval-mode"], (v) => v !== "default", "default", notes);
      return { args, notes };
    }
    default:
      return { args: [...input.args], notes };
  }
}

// ===== claude に渡す secure 設定（--settings） =====

export interface SecureSettingsInput {
  /** ebi-team.config.json の絶対パス。 */
  configPath: string;
  /** 生成する secure 設定ファイル自身の絶対パス（書き換えを止める）。 */
  settingsPath: string;
  /** hook スクリプトの絶対パス（書き換えを止める）。 */
  hookScriptPath: string;
  /** PreToolUse hook として実行するコマンド行（シェル経由）。 */
  hookCommand: string;
  /** 承認待ちの自動拒否までの時間（ms）。hook の timeout はこれより長くする。 */
  approvalTimeoutMs: number;
}

/** claude の permission ルールで絶対パスを指す書き方（`//abs/path`）。 */
function absRule(path: string): string {
  return `/${path.startsWith("/") ? path : `/${path}`}`;
}

/** 読ませない秘密のファイル（Read ルールは Grep / Glob にも効く）。 */
export function secretReadRules(): string[] {
  const homeRel = (p: string): string => `~/${p}`;
  return [
    "Read(**/.env)",
    "Read(**/*.env)",
    "Read(**/.env.local)",
    "Read(**/.env.*.local)",
    "Read(**/.env.production)",
    "Read(**/.env.prod)",
    "Read(**/.dev.vars)",
    `Read(${homeRel(".secrets/**")})`,
    `Read(${homeRel(".cloudflare/**")})`,
    `Read(${homeRel(".wrangler/**")})`,
    `Read(${homeRel("Library/Preferences/.wrangler/**")})`,
    `Read(${homeRel(".config/.wrangler/**")})`,
    `Read(${homeRel(".claude/channels/**")})`,
  ];
}

/**
 * secure 設定（claude の --settings に渡す JSON）を組み立てる純関数。
 * - permissions.deny: 秘密の Read・設定ファイルの Edit・WebFetch・外部送信
 * - hooks.PreToolUse(Bash): git push・本番の操作をチャット承認へ回す／秘密への言及を止める
 * - hooks.PermissionRequest: 権限の確認をチャット承認へ回す
 */
export function buildSecureSettings(input: SecureSettingsInput): Record<string, unknown> {
  const deny = [
    ...secretReadRules(),
    // 権限・設定の書き換え（自分で許可を付ける経路）を止める
    `Edit(${absRule(input.configPath)})`,
    "Edit(~/.claude/settings.json)",
    "Edit(~/.claude/settings.local.json)",
    `Edit(${absRule(input.settingsPath)})`,
    `Edit(${absRule(input.hookScriptPath)})`,
    // 外部送信
    "WebFetch",
    "Bash(gh pr comment:*)",
    "Bash(gh issue comment:*)",
    "Bash(gh pr review:*)",
    "mcp__plugin_discord_discord",
    "mcp__plugin_slack_slack",
    "mcp__discord",
    "mcp__slack",
  ];
  const hook = {
    type: "command",
    command: input.hookCommand,
    // 秒。承認待ち（自動拒否まで）＋余裕。ここで切れると hook エラーになる。
    timeout: Math.ceil(input.approvalTimeoutMs / 1000) + 60,
  };
  return {
    permissions: { deny },
    hooks: {
      // git push・本番の操作をチャット承認へ／秘密への言及・外部送信を止める
      PreToolUse: [{ matcher: "Bash", hooks: [hook] }],
      // 権限の確認（auto / acceptEdits で出るダイアログ）をチャットの承認バブルへ回す。
      // AskUserQuestion は hook 側で素通しする（master の「ボスに聞く」を壊さない）。
      PermissionRequest: [{ matcher: "*", hooks: [hook] }],
    },
  };
}

/** シェルに渡す 1 引数のクォート（単一引用符）。 */
export function shellQuote(s: string): string {
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 承認待ちの既定（10 分）。env EBI_SECURE_APPROVAL_TIMEOUT_MS で変えられる。 */
export const DEFAULT_SECURE_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export function resolveApprovalTimeoutMs(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SECURE_APPROVAL_TIMEOUT_MS;
}

/** 承認バブルに出すツール名（「承認が必要: <これ>」）。 */
export function secureApprovalTitle(from: string | null, label: string): string {
  return `${label}（${from ?? "不明なエビ"}・セキュアモード）`;
}

// ===== エビの cwd を許可ルート配下に限る =====

/** 実在すれば realpath（symlink 越しの脱出を防ぐ）、無ければ resolve しただけの絶対パス。 */
function realOrResolved(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** path が roots のどれかの配下（同一を含む）か。純関数寄り（realpath だけ fs を見る）。 */
export function isPathUnderRoots(path: string, roots: readonly string[]): boolean {
  const target = realOrResolved(path);
  return roots.some((root) => {
    const r = realOrResolved(root);
    const rel = relative(r, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/** secure で cwd / repoPath が許可ルート外なら拒否する（viewer・ファイル編集と同じ考え方）。 */
export function assertSecureCwd(mode: SecurityMode, paths: readonly string[], roots: readonly string[]): void {
  if (mode !== "secure") return;
  for (const p of paths) {
    if (!isPathUnderRoots(p, roots)) {
      throw new SecureModeRejection(`cwd ${p} は許可ルート（${roots.join(", ")}）の外です`);
    }
  }
}
