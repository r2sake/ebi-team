import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_BACKEND_ID,
  GEMINI_TRAITS,
  applyEnvDenyList,
  getBackend,
  resolveGeminiModel,
  toGeminiApprovalMode,
  writeGeminiRuntime,
  type BackendId,
} from "./backends/index.ts";

/**
 * 監督・要約エンジン（サブスク課金・API キー不要）。
 *
 * 設計方針（Phase3 バッチC で API → CLI へ置換）:
 * - 要約は `claude --print --model haiku` のワンショット subprocess で行う。
 *   Claude Max サブスクの `claude` CLI が課金経路になるため **`@anthropic-ai/sdk` /
 *   `ANTHROPIC_API_KEY` には一切依存しない**（API 課金が発生しない）。
 * - 有効/無効は **「claude バイナリが使えるか」** で自動判定する（EBI_SUPERVISOR の
 *   ON/OFF ガードは撤廃）。claude が PATH に無ければ機能無効＋notice で通知する。
 * - コスト最小。自動ポーリング監督はしない。要求された時だけ、対象エビの直近
 *   スクロールバックを 1 回だけ Haiku に投げる。
 * - 役割の分離: ここで担うのは **プログラム的なワンショット要約**。常駐 supervisor
 *   セッション（config の固定エビ・PTY）は対話的な監視/相談用であり、要約 API は
 *   常駐に依存しない（config から supervisor を外しても要約は動く）。
 * - スタブ機構: 実行コマンドは `EBI_SUMMARY_CMD`（スペース区切り）で差し替え可能。
 *   テストでは `echo` 等のダミーに差して実 claude を叩かずに経路を検証する。
 *   本番では未設定＝`claude --print --model haiku` 既定。
 */

// claude エンジンで要約に使うモデル alias（サブスク・最安の Haiku）。
const CLAUDE_SUMMARY_MODEL = "haiku";

/**
 * gemini エンジンで要約に使う既定モデル（明示 ID）。
 *
 * 実測（2026-09-05・gemini-cli 0.58.0 / Code Assist 経路）:
 * - `gemini-3.8-flash`（ボス言うところの「Flash 3.8」）は Gemini API / AI Studio には実在するが、
 *   **Code Assist 経路では未提供**。指定しても 404 にはならず、存在しない `gemini-9.9-flash` と
 *   同じく**黙って `gemini-3.5-flash` にフォールバック**して応答が返る（-o json の
 *   stats.models キーが `gemini-3.5-flash` になることで判別できる）。
 * - `gemini-flash-latest` / `*-preview` / `*-lite` 等の alias は従来どおり 404。
 * したがって「実際に使える Flash 系最新」＝ `gemini-3.5-flash` を明示指定する。
 */
const GEMINI_SUMMARY_MODEL = "gemini-3.5-flash";

/** 要約エンジン用の per-エビ runtime（役割 GEMINI.md / settings.json）の agentId。 */
const GEMINI_SUMMARY_AGENT_ID = "_supervisor-summary";
// ワンショット要約のタイムアウト（ms）。固まり防止。
const TIMEOUT_MS = 60_000;
// claude へ渡すスクロールバックの上限（文字）。長すぎる入力を末尾優先で切り詰める。
const MAX_INPUT_CHARS = 24_000;
// これ未満のスクロールバックは「要約するほどの中身が無い」と判断する。
const MIN_INPUT_CHARS = 40;
// stdout の上限（バイト）。暴走出力で OOM しないための保険。
const MAX_STDOUT_BYTES = 1024 * 1024;

// 監督役割の system prompt（--append-system-prompt に渡す。日本語）。
const SYSTEM_PROMPT =
  "あなたは複数の Claude Code セッション（ターミナル）を見守る監督アシスタントです。" +
  "渡されるのは1つのセッションの直近のターミナル出力（ANSI エスケープ等のノイズを含む）です。" +
  "日本語で、3〜5行の箇条書きで簡潔に要約してください。" +
  "観点は次の3つ: (1) いま何が起きているか / 何の作業中か、" +
  "(2) エラーや確認待ちなど詰まっていないか、(3) 次に取るべきアクション。" +
  "推測は推測と明示し、ノイズや無関係な装飾は無視してください。前置きや締めの挨拶は不要です。";

/** 要約結果。ok=false のときは reason を notice として返す想定。 */
export type SummarizeResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/** 要約エンジン 1 回分の起動形（純関数で決める＝単体テスト対象）。 */
export interface SummaryEngine {
  /** 起動バイナリ。 */
  cmd: string;
  /** プロンプト本文より前に置く固定引数。 */
  baseArgs: string[];
  /**
   * プロンプト本文の直前に置くフラグ（gemini は `-p`、claude は位置引数なので null）。
   */
  promptFlag: string | null;
  /**
   * 役割 system prompt を引数で渡す場合の引数列（claude の `--append-system-prompt`）。
   * gemini は per-エビ GEMINI.md（env 経由）で渡すので空。
   */
  systemPromptArgs: string[];
  /** subprocess に足す env（gemini の system settings パス等）。 */
  env: Record<string, string>;
  /** どのバックエンドで要約するか（表示・ログ用）。スタブは null。 */
  backend: BackendId | null;
  /** 実際に使うモデル（表示・ログ用）。スタブは null。 */
  model: string | null;
  /** EBI_SUMMARY_CMD で差し替えたスタブか。 */
  isStub: boolean;
}

/** 要約エンジンの設定（常駐 supervisor 固定エビの backend / model を流用する）。 */
export interface SupervisorOptions {
  /** 要約に使うバックエンド。未指定は claude（従来どおり）。 */
  backend?: BackendId | null;
  /** 要約に使うモデル。未指定は各バックエンドの既定要約モデル。 */
  model?: string | null;
  /** gemini runtime（GEMINI.md / settings.json）の出力先ベース（テスト用）。 */
  geminiRuntimeBaseDir?: string;
}

/**
 * 要約エンジンの起動形を決める。
 *
 * 優先順:
 *   1. `EBI_SUMMARY_CMD`（スペース区切り・テスト用スタブ）— backend 指定より強い
 *   2. opts.backend（＝ config の supervisor 固定エビの backend）
 *   3. claude（既定・従来どおり `claude --print --model haiku --strict-mcp-config`）
 *
 * gemini は `--append-system-prompt` 相当を持たないため、役割プロンプトは
 * **per-エビ GEMINI.md**（`writeGeminiRuntime`・既存の役割プロンプト機構）で渡す。
 * また承認ダイアログが出ると `-p` のワンショットが応答を返さないため **yolo 固定**にする
 * （`acceptEdits`（auto_edit）は MCP 呼び出し・workspace 外読み取りで止まる）。
 *
 * codex は要約エンジンとしては未対応（`--print` 相当のワンショット非対話が別方言）。
 * 指定されたら claude へフォールバックする（黙って落とさず describeStartup で明示する）。
 */
export function resolveSummaryEngine(opts?: SupervisorOptions): SummaryEngine {
  const override = (process.env.EBI_SUMMARY_CMD ?? "").trim();
  if (override) {
    const parts = override.split(/\s+/);
    return {
      cmd: parts[0],
      baseArgs: parts.slice(1),
      promptFlag: null,
      systemPromptArgs: [],
      env: {},
      backend: null,
      model: null,
      isStub: true,
    };
  }

  if (opts?.backend === "gemini") {
    const model = resolveGeminiModel(opts.model ?? null, GEMINI_SUMMARY_MODEL);
    return {
      cmd: getBackend("gemini").defaultCommand,
      // -p: 非対話（headless）。承認ダイアログで固まらないよう yolo 固定。
      baseArgs: ["-m", model, "--approval-mode", toGeminiApprovalMode("bypassPermissions")],
      promptFlag: "-p",
      systemPromptArgs: [],
      env: geminiSummaryEnv(opts.geminiRuntimeBaseDir),
      backend: "gemini",
      model,
      isStub: false,
    };
  }

  const model = opts?.model ?? CLAUDE_SUMMARY_MODEL;
  return {
    cmd: getBackend(DEFAULT_BACKEND_ID).defaultCommand,
    // --print: ワンショット非対話。--strict-mcp-config: 余計な MCP を読み込ませない。
    baseArgs: ["--print", "--model", model, "--strict-mcp-config"],
    promptFlag: null,
    systemPromptArgs: ["--append-system-prompt", SYSTEM_PROMPT],
    env: {},
    backend: "claude",
    model,
    isStub: false,
  };
}

/**
 * gemini ワンショット要約用の env を作る。
 * 役割プロンプト（SYSTEM_PROMPT）を per-エビ GEMINI.md として書き出し、その置き場を
 * `context.includeDirectories` に入れた system settings のパスを返す（制御MCP は載せない）。
 */
function geminiSummaryEnv(baseDir?: string): Record<string, string> {
  return writeGeminiRuntime({
    agentId: GEMINI_SUMMARY_AGENT_ID,
    mcpConfigPath: null,
    systemPrompt: SYSTEM_PROMPT,
    baseDir,
  });
}

/** 要約 1 回分の実引数を組み立てる純関数（プロンプト本文は常に最後）。 */
export function buildSummaryArgs(engine: SummaryEngine, prompt: string): string[] {
  const args = [...engine.baseArgs, ...engine.systemPromptArgs];
  if (engine.promptFlag) args.push(engine.promptFlag);
  args.push(prompt);
  return args;
}

export class Supervisor {
  /** 要約機能が有効か（要約エンジンのバイナリ or スタブが使えるか）。 */
  readonly enabled: boolean;
  private readonly engine: SummaryEngine;
  /** codex を指定されて claude へフォールバックしたか（起動ログで明示する）。 */
  private readonly fellBackFromBackend: BackendId | null;

  constructor(opts?: SupervisorOptions) {
    // codex はワンショット要約エンジン未対応。claude へ落として起動ログで明示する。
    const requested = opts?.backend ?? null;
    const usable = requested === "codex" ? null : requested;
    this.fellBackFromBackend = requested === "codex" ? requested : null;
    this.engine = resolveSummaryEngine({ ...opts, backend: usable });
    // スタブ時は常に有効。既定時は PATH 上にバイナリがあるかで判定する。
    this.enabled = this.engine.isStub || hasBinaryOnPath(this.engine.cmd);
  }

  /**
   * 起動時ログ。キー等の機密は出さない。有効/無効と要約エンジンのみ。
   */
  describeStartup(): string {
    const note =
      this.fellBackFromBackend === null
        ? ""
        : `（supervisor の backend=${this.fellBackFromBackend} は要約エンジン未対応のため claude で代替）`;
    if (!this.enabled) {
      return `監督・要約: 無効（${this.engine.cmd} が PATH に見つかりません）${note}`;
    }
    if (this.engine.isStub) return `監督・要約: 有効（スタブ: ${this.engine.cmd}）`;
    const label =
      this.engine.backend === "gemini"
        ? `サブスク gemini CLI / ${this.engine.model} ワンショット要約`
        : `サブスク claude CLI / ${this.engine.model} ワンショット要約`;
    return `監督・要約: 有効（${label}）${note}`;
  }

  /**
   * 対象 agent のスクロールバックを要約エンジンで 1 回だけ要約する。
   * エンジンのバイナリが無い（enabled=false）ときは notice を返す。
   */
  async summarize(scrollback: string): Promise<SummarizeResult> {
    if (!this.enabled) {
      return { ok: false, reason: `監督・要約は無効です（${this.engine.cmd} が見つかりません）` };
    }

    const trimmed = scrollback.trim();
    if (trimmed.length < MIN_INPUT_CHARS) {
      return { ok: false, reason: "出力がまだ少ないため要約をスキップしました" };
    }

    // 末尾（＝直近）優先で上限まで切り詰める。全ログを流し続けない方針。
    const input =
      trimmed.length > MAX_INPUT_CHARS ? trimmed.slice(-MAX_INPUT_CHARS) : trimmed;

    // 要約指示 + ログ本文を 1 つのプロンプト引数にまとめる。
    const prompt =
      "以下はあるセッションの直近ターミナル出力です。指示どおり日本語で要約してください。\n\n" +
      "```\n" +
      input +
      "\n```";

    try {
      const text = await runOnce(this.engine.cmd, buildSummaryArgs(this.engine, prompt), this.engine);
      const cleaned = text.trim();
      if (!cleaned) return { ok: false, reason: "要約が空でした" };
      return { ok: true, text: cleaned };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `要約に失敗しました: ${reason}` };
    }
  }
}

/**
 * subprocess を 1 回だけ実行し、stdout を文字列で返す（引数配列・シェル非経由）。
 * タイムアウト・非0終了・stdout 上限超過は reject する。
 */
function runOnce(cmd: string, args: string[], engine: SummaryEngine): Promise<string> {
  // gemini エンジンは API キー課金・別認証経路の env を親から落としてから起動する
  //（PTY 経路の envDenyList と同じ扱い。サブスク枠以外に載せない）。
  const parentEnv =
    engine.backend === "gemini"
      ? applyEnvDenyList(process.env, GEMINI_TRAITS.envDenyList)
      : process.env;
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_STDOUT_BYTES,
        // 標準出力を文字列で受ける。
        encoding: "utf8",
        env: { ...parentEnv, ...engine.env },
        // PTY は使わない。stdin は閉じる（--print / -p は stdin を待たない）。
      },
      (error, stdout, stderr) => {
        if (error) {
          // タイムアウト時は error.killed=true / signal が付く。
          const detail = (stderr || "").toString().trim().slice(-300);
          reject(new Error(detail ? `${error.message}（${detail}）` : error.message));
          return;
        }
        resolve(stdout.toString());
      },
    );
  });
}

/**
 * 絶対/相対パス指定ならそのファイルの存在を、コマンド名なら PATH 上の有無を判定する。
 * 同期・軽量（起動時 1 回だけ呼ぶ）。失敗時は false（無効扱い）。
 */
function hasBinaryOnPath(cmd: string): boolean {
  // パス区切りを含むなら実ファイルとして存在チェック。
  if (cmd.includes("/")) {
    return existsSync(cmd);
  }
  // コマンド名: PATH を走査して実行可能ファイルを探す。
  const pathEnv = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, cmd + ext))) return true;
    }
  }
  return false;
}
