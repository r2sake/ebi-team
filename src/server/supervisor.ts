import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

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

// 要約に使うモデル alias（サブスク・最安の Haiku）。
const SUMMARY_MODEL = "haiku";
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

/**
 * 要約エンジンの起動コマンドを決める。
 * 既定: `claude --print --model haiku --strict-mcp-config`。
 * `EBI_SUMMARY_CMD`（スペース区切り）があればそれを使う（テスト用スタブ）。
 * 返すのは「コマンド + 固定引数」。要約指示・ログ本文は呼び出し側で末尾に積む。
 */
function summaryCommand(): { cmd: string; baseArgs: string[]; isStub: boolean } {
  const override = (process.env.EBI_SUMMARY_CMD ?? "").trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { cmd: parts[0], baseArgs: parts.slice(1), isStub: true };
  }
  return {
    cmd: "claude",
    // --print: ワンショット非対話。--strict-mcp-config: 余計な MCP を読み込ませない。
    baseArgs: ["--print", "--model", SUMMARY_MODEL, "--strict-mcp-config"],
    isStub: false,
  };
}

export class Supervisor {
  /** 要約機能が有効か（claude バイナリ or スタブが使えるか）。 */
  readonly enabled: boolean;
  private readonly cmd: string;
  private readonly baseArgs: string[];
  private readonly isStub: boolean;

  constructor() {
    const { cmd, baseArgs, isStub } = summaryCommand();
    this.cmd = cmd;
    this.baseArgs = baseArgs;
    this.isStub = isStub;
    // スタブ時は常に有効。既定（claude）時は PATH 上に claude があるかで判定する。
    this.enabled = isStub || hasBinaryOnPath(cmd);
  }

  /**
   * 起動時ログ。キー等の機密は出さない。有効/無効と要約エンジンのみ。
   */
  describeStartup(): string {
    if (this.enabled) {
      return this.isStub
        ? `監督・要約: 有効（スタブ: ${this.cmd}）`
        : "監督・要約: 有効（サブスク claude CLI / Haiku ワンショット要約）";
    }
    return "監督・要約: 無効（claude が PATH に見つかりません）";
  }

  /**
   * 対象 agent のスクロールバックを Haiku で 1 回だけ要約する。
   * claude が無い（enabled=false）ときは notice を返す。
   */
  async summarize(scrollback: string): Promise<SummarizeResult> {
    if (!this.enabled) {
      return { ok: false, reason: "監督・要約は無効です（claude が見つかりません）" };
    }

    const trimmed = scrollback.trim();
    if (trimmed.length < MIN_INPUT_CHARS) {
      return { ok: false, reason: "出力がまだ少ないため要約をスキップしました" };
    }

    // 末尾（＝直近）優先で上限まで切り詰める。全ログを流し続けない方針。
    const input =
      trimmed.length > MAX_INPUT_CHARS ? trimmed.slice(-MAX_INPUT_CHARS) : trimmed;

    // 要約指示 + ログ本文を 1 つのプロンプト引数にまとめる（--print の位置引数）。
    const prompt =
      "以下はあるセッションの直近ターミナル出力です。指示どおり日本語で要約してください。\n\n" +
      "```\n" +
      input +
      "\n```";

    // 役割 system prompt は --append-system-prompt で注入する。
    // スタブ（echo 等）では claude 固有フラグを解釈できないので付けない。
    const args = this.isStub
      ? [...this.baseArgs, prompt]
      : [...this.baseArgs, "--append-system-prompt", SYSTEM_PROMPT, prompt];

    try {
      const text = await runOnce(this.cmd, args);
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
function runOnce(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_STDOUT_BYTES,
        // 標準出力を文字列で受ける。
        encoding: "utf8",
        // PTY は使わない。stdin は閉じる（--print は stdin を待たない）。
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
