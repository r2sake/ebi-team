// ClaudeHeadlessBrain — `claude -p --input-format stream-json --output-format stream-json` を
// 1 プロセス常駐させて多ターン会話を回す MasterBrain 実装。
//
// 設計書: docs/design/master-chat-ui-2026-09-05.md §3（r2）
// 実測:   docs/poc/master-headless-poc-2026-09-05.md
//
// このファイルは**副作用側**（spawn / stdin write / signal）に限定し、
// 引数組み立ては claudeArgs.ts、イベント正規化は claudeEvents.ts の純関数に委ねる。
// PR-M1 ではサーバのどこからも呼ばれない（UI 配線は PR-M2）＝外形ゼロ差分。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
  MasterCostLedger,
  unsupportedOf,
  type MasterBrain,
  type MasterBrainCapabilities,
  type MasterBrainInput,
  type MasterBrainStartOptions,
  type MasterEvent,
} from "./brain.ts";
import {
  applyMasterEnvDenyList,
  buildClaudeHeadlessArgs,
  evaluateInitApiKeySource,
  evaluateMasterPreflight,
} from "./claudeArgs.ts";
import { ClaudeStreamNormalizer, parseNdjsonLine } from "./claudeEvents.ts";
import {
  MASTER_PERMISSION_PROMPT_TOOL,
  PermissionBroker,
  type MasterAnswer,
  type MasterPermissionDecision,
  type MasterPermissionRequest,
} from "./permission.ts";

/** claude 頭脳が実装できる機能（設計書 §3.2 の射影表 claude 列）。 */
export const CLAUDE_BRAIN_CAPABILITIES: MasterBrainCapabilities = {
  partialText: true,
  thinking: true,
  permissionPrompt: true,
  askUserQuestion: true,
  interrupt: true,
  resume: true,
  cost: true,
  contextPct: true,
  images: true,
};

/**
 * replay ACK を待つ既定タイムアウト(ms)。
 * PoC 実測で ACK は即時ではない（起動直後 3.4s / 走行中割り込み 4.7s）。
 * **タイムアウトしても再送しない**（二重投入になる）。返り値 acked:false で呼び出し側へ知らせるだけ。
 */
const DEFAULT_ACK_TIMEOUT_MS = 60_000;

/** interrupt の control_response を待つタイムアウト(ms)。実測 19ms なので十分に余裕がある。 */
const INTERRUPT_TIMEOUT_MS = 10_000;

/** stop() で SIGINT を送ってから SIGKILL するまでの猶予(ms)。 */
const STOP_GRACE_MS = 3_000;

export interface ClaudeHeadlessBrainOptions {
  /** 実行バイナリ（既定 "claude"）。 */
  command?: string;
  /** 親 env（既定 process.env）。deny list はこの上に適用される。 */
  parentEnv?: Record<string, string | undefined>;
  /** `--include-partial-messages` を付けるか（既定 false・PR-M3 で true にする）。 */
  includePartialMessages?: boolean;
  ackTimeoutMs?: number;
  /**
   * `--permission-prompt-tool` に渡す MCP ツール名（既定 mcp__ebi-control__permission_prompt）。
   * **`--mcp-config` を渡すときだけ**引数に載る（無いと claude が起動時に即死する）。
   */
  permissionPromptTool?: string | null;
  /** プロセスを跨いだコスト累計のレジャ（resume を挟む運用で共有する）。 */
  costLedger?: MasterCostLedger;
  /**
   * 正規化前の生 NDJSON イベントの覗き口（best-effort・例外は握り潰す）。
   * MasterEvent の union に載せるほどではないが呼び出し側が要る情報
   *（`rate_limit_event` の枠情報など）を取り出すために使う。**正規化経路には影響しない**。
   */
  onRawEvent?: (raw: unknown) => void;
}

interface PendingAck {
  text: string;
  resolve(acked: boolean): void;
  timer: NodeJS.Timeout;
}

export class ClaudeHeadlessBrain implements MasterBrain {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_BRAIN_CAPABILITIES;
  readonly unsupported = unsupportedOf(CLAUDE_BRAIN_CAPABILITIES);
  readonly costLedger: MasterCostLedger;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: ReadlineInterface | null = null;
  private readonly normalizer = new ClaudeStreamNormalizer();
  private readonly queue: MasterEvent[] = [];
  private waiter: ((ev: IteratorResult<MasterEvent>) => void) | null = null;
  private closed = false;
  private readonly pendingAcks: PendingAck[] = [];
  private readonly pendingControl = new Map<string, () => void>();
  /** 起動ごとに変わるキー（コスト累計をプロセス単位で持つため）。 */
  private processKey = "";
  private startedArgs: readonly string[] = [];
  /**
   * 承認 / 質問の保留台帳（PR-M5）。
   * **プロセスを跨いで生かさない**（プロセスが死んだら保留は破棄する）が、
   * ブローカ自体はインスタンス寿命で持つ（stop → start の間に要求は来ない）。
   */
  private readonly broker = new PermissionBroker({
    onPermission: (ev) =>
      this.emit({ kind: "permission", id: ev.id, toolName: ev.toolName, input: ev.input }),
    onQuestion: (ev) =>
      this.emit({
        kind: "question",
        id: ev.id,
        header: ev.header,
        question: ev.question,
        options: ev.options,
        multi: ev.multi,
      }),
    onSettled: (ev) =>
      this.emit({
        kind: "permissionSettled",
        id: ev.id,
        outcome: ev.outcome,
        answer: ev.answer,
      }),
    onNotice: (text) => this.emit({ kind: "notice", level: "warn", text }),
  });

  constructor(private readonly opts: ClaudeHeadlessBrainOptions = {}) {
    this.costLedger = opts.costLedger ?? new MasterCostLedger();
  }

  /** 実際に spawn した引数列（テスト・ログ用）。 */
  get args(): readonly string[] {
    return this.startedArgs;
  }

  /** 子プロセスの pid（未起動なら null）。 */
  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  async start(startOpts: MasterBrainStartOptions): Promise<void> {
    if (this.proc) throw new Error("ClaudeHeadlessBrain は既に起動しています");
    const args = buildClaudeHeadlessArgs({
      model: startOpts.model,
      permissionMode: startOpts.permissionMode,
      systemPrompt: startOpts.systemPrompt,
      mcpConfigPath: startOpts.mcpConfigPath,
      resumeSessionId: startOpts.resumeSessionId,
      includePartialMessages: this.opts.includePartialMessages === true,
      // 承認ツールは MCP 経由でしか解決できないので、--mcp-config があるときだけ付ける。
      permissionPromptTool: startOpts.mcpConfigPath
        ? (this.opts.permissionPromptTool ?? MASTER_PERMISSION_PROMPT_TOOL)
        : null,
      extraArgs: startOpts.extraArgs,
    });
    const parentEnv = this.opts.parentEnv ?? process.env;
    const childEnv = applyMasterEnvDenyList(parentEnv);
    const pre = evaluateMasterPreflight({ args, childEnv, parentEnv });
    if (!pre.ok) {
      throw new Error(`master の起動前チェックに失敗しました: ${pre.errors.join(" / ")}`);
    }

    this.processKey = randomUUID();
    this.startedArgs = args;
    const proc = spawn(this.opts.command ?? "claude", args, {
      cwd: startOpts.cwd,
      env: childEnv as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.closed = false;

    for (const w of pre.warnings) this.emit({ kind: "notice", level: "warn", text: w });

    this.rl = createInterface({ input: proc.stdout });
    this.rl.on("line", (line) => this.onLine(line));
    proc.stderr.on("data", (d) => {
      const text = String(d).trim();
      if (text) this.emit({ kind: "notice", level: "warn", text: `stderr: ${text}` });
    });
    proc.on("exit", (code, signal) => {
      this.emit({ kind: "exit", code, signal });
      this.finish();
    });
    proc.on("error", (err) => {
      this.emit({ kind: "notice", level: "error", text: `起動に失敗しました: ${err.message}` });
      this.finish();
    });

    // A) system/init を待たない。init は「最初の user メッセージ送信後」にしか出ないため、
    //    ここで待つとデッドロックする（PoC 実測: 2 分待っても出ない）。
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        proc.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        proc.off("spawn", onSpawn);
        reject(err);
      };
      proc.once("spawn", onSpawn);
      proc.once("error", onError);
    });
  }

  async send(input: MasterBrainInput): Promise<{ acked: boolean }> {
    const proc = this.proc;
    if (!proc || this.closed) throw new Error("master プロセスが起動していません");
    const content: unknown[] = [{ type: "text", text: input.text }];
    for (const img of input.images ?? []) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.base64 },
      });
    }
    const line = JSON.stringify({ type: "user", message: { role: "user", content } });
    const acked = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const i = this.pendingAcks.findIndex((p) => p.timer === timer);
        if (i >= 0) this.pendingAcks.splice(i, 1);
        resolve(false); // F) 再送はしない（二重投入になる）
      }, this.opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS);
      this.pendingAcks.push({ text: input.text, resolve, timer });
    });
    proc.stdin.write(`${line}\n`);
    return { acked: await acked };
  }

  events(): AsyncIterable<MasterEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<MasterEvent> {
        return {
          next(): Promise<IteratorResult<MasterEvent>> {
            const buffered = self.queue.shift();
            if (buffered) return Promise.resolve({ value: buffered, done: false });
            if (self.closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => {
              self.waiter = resolve;
            });
          },
        };
      },
    };
  }

  /**
   * `--permission-prompt-tool`（制御MCP の permission_prompt）から届いた承認要求。
   * **ボスが答えるまで resolve しない**（未応答は待ち続ける・自動拒否しない）。
   * signal は HTTP 接続の切断＝claude 側がツール呼び出しを諦めた合図。
   */
  requestPermission(
    req: MasterPermissionRequest,
    signal?: AbortSignal,
  ): Promise<MasterPermissionDecision> {
    if (this.closed) return Promise.resolve({ behavior: "deny", message: "master プロセスが停止しています" });
    return this.broker.request(req, signal);
  }

  /** 未応答の承認/質問の件数。 */
  get pendingPermissions(): number {
    return this.broker.pendingCount;
  }

  /**
   * 承認 / 質問への応答（WS `chatAnswer` → MasterSession → ここ）。
   * 応答は stdin ではなく **保留中の MCP ツール呼び出しの戻り値**として claude へ返る
   *（PR-M5 実測。設計書 §0.6-N）。
   */
  async answer(id: string, decision: MasterAnswer): Promise<void> {
    this.broker.answer(id, decision);
  }

  /**
   * 実行中ターンの中断。
   * SIGINT / SIGTERM は使わない（SIGTERM はターンを未完のまま残す）。
   * stdin へ control_request を 1 行書くだけで止まる（PoC 実測 19ms）。
   */
  async interrupt(): Promise<void> {
    const proc = this.proc;
    if (!proc || this.closed) return;
    const requestId = `ebi-int-${randomUUID()}`;
    this.normalizer.markInterruptRequested();
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId);
        resolve();
      }, INTERRUPT_TIMEOUT_MS);
      this.pendingControl.set(requestId, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    proc.stdin.write(
      `${JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "interrupt" },
      })}\n`,
    );
    await done;
  }

  sessionId(): string | null {
    return this.normalizer.sessionId;
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    if (proc.exitCode !== null || proc.signalCode !== null) {
      this.finish();
      return;
    }
    proc.stdin.end();
    proc.kill("SIGINT");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        resolve();
      }, STOP_GRACE_MS);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.finish();
  }

  /** テスト用: NDJSON 1 行を直接食わせる（プロセスを起動せずに正規化経路を確かめる）。 */
  ingestLineForTest(line: string): void {
    this.onLine(line);
  }

  private onLine(line: string): void {
    const raw = parseNdjsonLine(line);
    if (raw == null) return;
    if (this.opts.onRawEvent) {
      // 覗き口の失敗で会話を壊さない（best-effort）。
      try {
        this.opts.onRawEvent(raw);
      } catch (err) {
        console.warn("[master-chat] onRawEvent で例外:", (err as Error).message);
      }
    }
    this.settleRawSideEffects(raw);
    for (const ev of this.normalizer.push(raw)) {
      if (ev.kind === "ack") {
        this.settleAck(ev.text);
        continue; // ACK は send() の返り値で伝えるので UI ストリームへは流さない
      }
      if (ev.kind === "session") {
        const check = evaluateInitApiKeySource(ev.apiKeySource);
        for (const w of check.warnings) this.emit({ kind: "notice", level: "warn", text: w });
        for (const e of check.errors) this.emit({ kind: "notice", level: "error", text: e });
      }
      if (ev.kind === "turnEnd") {
        this.costLedger.noteProcessTotal(this.processKey, ev.costUsd);
      }
      this.emit(ev);
    }
  }

  /** 正規化では捨てるが制御上は要る生イベント（control_response）を処理する。 */
  private settleRawSideEffects(raw: unknown): void {
    if (typeof raw !== "object" || raw === null) return;
    const rec = raw as Record<string, unknown>;
    if (rec.type !== "control_response") return;
    const response = rec.response as Record<string, unknown> | undefined;
    const requestId = typeof response?.request_id === "string" ? response.request_id : null;
    if (!requestId) return;
    const done = this.pendingControl.get(requestId);
    if (done) {
      this.pendingControl.delete(requestId);
      done();
    }
  }

  private settleAck(text: string): void {
    const i = this.pendingAcks.findIndex((p) => p.text === text);
    if (i < 0) return;
    const [p] = this.pendingAcks.splice(i, 1);
    clearTimeout(p.timer);
    p.resolve(true);
  }

  private emit(ev: MasterEvent): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: ev, done: false });
      return;
    }
    this.queue.push(ev);
  }

  private finish(): void {
    if (this.closed) return;
    // 保留は**プロセスと運命を共にする**（次のプロセスへ引き継がない）。
    // closed を立てる前に畳むので、破棄イベントはまだイベント列に載る。
    this.broker.discardAll("頭脳プロセスが終了しました");
    this.closed = true;
    this.rl?.close();
    this.rl = null;
    for (const p of this.pendingAcks.splice(0)) {
      clearTimeout(p.timer);
      p.resolve(false);
    }
    for (const [, done] of this.pendingControl) done();
    this.pendingControl.clear();
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }
}
