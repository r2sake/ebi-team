import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Agent, type SpawnConfig, type AgentHandlers, type LaunchParams } from "./agent.ts";
import { Mailbox } from "./mailbox.ts";
import {
  BROADCAST_TARGET,
  type AgentMode,
  type AgentRecord,
  type AgentKind,
} from "../shared/protocol.ts";

/**
 * 配送方式の切り替え。**既定は notify**（notification 注入。購読者がいるエビのみで、
 * 購読未確立の宛先は PTY へ自動フォールバック）。`EBI_INJECT_MODE=pty` を明示すると
 * 従来の PTY 入力欄タイプ方式へ全面ロールバックできる。
 *
 * 【2026-07-11 確定: notification 注入は「機構としては成立」／ただし無人運用に未解決の関門あり】
 * harness バイナリ解析＋実機 e2e で、notification が honor される条件を特定し、実際に
 * master→エビへ注入 → 受信側に channel メッセージとして届き応答が返ることを確認した
 * （scrollback に `ebi-control:[from:master] …` と `⏺ACK_INJECT_OK`）。成立条件:
 *   1. MCP サーバが initialize の capabilities で `experimental: {"claude/channel": {}}`
 *      を宣言（src/mcp/control-server.ts で宣言済み。過去2回の不成立はこれの欠落が直接原因）。
 *   2. そのサーバ名がセッションの channels に載っていること。素の MCP サーバは spawn 時の
 *      `--dangerously-load-development-channels server:<server名>` で dev channel 登録する。
 *
 * ★解決済み（運用者承認のもと有効化）: 上記フラグを付けた claude は起動時に
 *   「WARNING: Loading development channels（I am using this for local development / Exit）」
 *   の対話ダイアログを毎回出す（firstParty サブスク＋managed policy 無しの通常環境では
 *   env/config での恒久スキップ手段が無い）。これは agent.ts の起動ゲート自動応答
 *   （maybeAnswerStartupGates）が "1"+Enter を自動送出して越える。安全限定＝spawn 引数の
 *   dev-channels 値が server:ebi-control ちょうど1個のときのみ・起動時間窓内のみ発火。
 *   live e2e 19/20 OK（2026-07-11）。
 *
 * 注意: notification の zod スキーマ上、params.meta の値は string のみ許容
 * （subscribeLoop 側は全フィールド String() 済み）。
 */
const INJECT_MODE = process.env.EBI_INJECT_MODE === "pty" ? "pty" : "notify";

/** notification 注入モードが有効か（モジュールレベル・spawn 配線の判定に使う）。 */
export function isNotifyMode(): boolean {
  return INJECT_MODE === "notify";
}

/**
 * agent が「制御MCP ブリッジを持つ（= notification 購読が期待できる）」か。
 * claude コマンドかつ起動引数に --mcp-config があるかで判定する
 * （役割付き動的エビ・master 固定エビが該当。bash テスト起動や役割なし dynamic は該当しない）。
 * spawn 直後にまだ初回 subscribe が来ていない相手を「待つ価値があるか」の
 * 事前判定に使う（無ければ PTY へ即フォールバックして無駄な待ちを作らない）。
 */
export function hasControlBridge(agent: Pick<Agent, "launch">): boolean {
  const { command, args } = agent.launch;
  const isClaude = command === "claude" || command.endsWith("/claude");
  return isClaude && args.includes("--mcp-config");
}

/**
 * 注入の宛先解決結果。
 * - delivered: 実際に注入を行った agent id 一覧
 * - rejected: ルールにより拒否した宛先と理由（送信元への notice 表示用）
 */
export interface InjectResult {
  delivered: string[];
  rejected: { id: string; reason: string }[];
}

/** spawn 時のオプション（worktree 情報など）。 */
export interface SpawnOptions {
  /** id を明示したい場合（省略時はサーバ採番）。 */
  id?: string;
  /** registry の公開フィールド branch に記録するブランチ名。 */
  branch?: string;
  /** worktree 由来の場合の元 repo（トップレベル）。kill 時の remove に使う。 */
  worktreeRepo?: string;
  /** worktree 由来の場合の worktree 絶対パス。 */
  worktreePath?: string;
  /** エビ種別（既定 dynamic）。固定エビは master/supervisor を指定する。 */
  kind?: AgentKind;
  /** 固定エビ（削除不可・自動再起動対象）か。既定 false。 */
  pinned?: boolean;
  /** 動的エビの役割（roles.ts の EBI_ROLES id）。バッジ表示・台帳用。 */
  role?: string | null;
  /**
   * notification（mailbox 購読）経路で受信するか。既定 true。
   * false のエビは「受信を PTY 注入に固定」する（sendMessage が購読確立を待たず即 PTY）。
   */
  notifySubscribe?: boolean;
  /**
   * 起動パラメータを明示する場合（固定エビ用）。
   * 未指定なら spawnConfig（サーバ既定 command/args）から cwd を当てて構築する。
   */
  launch?: LaunchParams;
}

/** worktree 由来 agent の内部メタ（kill 時のクリーンアップ用に取り出す）。 */
export interface WorktreeMeta {
  repo: string;
  path: string;
}

/**
 * agent の registry（メモリ保持 + JSON ダンプ）。
 * 変更のたびに dumpPath へ書き出す。再起動時の復元は MVP ではしない（ダンプのみ）。
 */
export class Registry {
  private readonly agents = new Map<string, Agent>();
  private seq = 0;

  constructor(
    private readonly spawnConfig: SpawnConfig,
    private readonly dumpPath: string,
    /** notification 注入方式の郵便受け。未指定なら常に PTY 経路（テスト等の簡略化用）。 */
    private readonly mailbox: Mailbox | null = null,
  ) {}

  /** notification 配送が有効か（EBI_INJECT_MODE=pty なら無効）。 */
  notifyEnabled(): boolean {
    return INJECT_MODE !== "pty" && this.mailbox !== null;
  }

  /** 指定 id が mailbox 経由で確実に届く状態か（一度でも購読 subscribe 済み）。 */
  hasActiveSubscriber(id: string): boolean {
    return this.notifyEnabled() && (this.mailbox?.everSubscribed(id) ?? false);
  }

  /**
   * spawn 直後の宛先が購読を確立するまで待つ（最大 timeoutMs）。
   * notification 無効 or mailbox 未設定なら即 false（呼び出し側は PTY 経路へ進む）。
   */
  async waitForSubscriber(id: string, timeoutMs: number): Promise<boolean> {
    if (!this.notifyEnabled()) return false;
    return this.mailbox!.waitForSubscriber(id, timeoutMs);
  }

  /**
   * 統一配送: mailbox に購読者がいれば notification 経路（PTY 非経由・busy/idle 無関係に即届く）、
   * いなければ従来の agent.inject()（PTY 入力欄タイプ・idle/busy キューあり）にフォールバックする。
   * kind 指定時は本文へ [idle]/[reply] タグを付与する（reverseInject 用・resolveAndInject は未指定）。
   * agent が存在しなければ false を返す（呼び出し側で見つからない扱いにする）。
   */
  deliver(id: string, from: string, message: string, kind?: "reply" | "idle"): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    const body = kind === "idle" ? `[idle] ${message}` : kind === "reply" ? `[reply] ${message}` : message;
    // notifySubscribe:false のエビ（外部チャンネル待機セッション・受信 PTY 固定）は、たとえ
    // 何らかの理由で購読者として登録されていても notification 経路に載せない。自セッションに
    // ebi-control channel が無く notification が harness に黙って捨てられるため（全配送経路
    // ―inject_message / @all ブロードキャスト / reverseInject―で PTY 注入を強制する）。
    if (agent.notifySubscribe !== false && this.hasActiveSubscriber(id)) {
      this.mailbox!.push(id, { from, message: body, kind: kind ?? "message", ts: Date.now() });
      return true;
    }
    agent.inject(from, body);
    return true;
  }

  /** id を採番する（例: ebi-1）。 */
  private nextId(): string {
    this.seq += 1;
    return `ebi-${this.seq}`;
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  /** 指定 agent が固定エビ（削除不可）か。存在しなければ false。 */
  isPinned(id: string): boolean {
    return this.agents.get(id)?.pinned ?? false;
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  list(): AgentRecord[] {
    return [...this.agents.values()].map((a) => a.toRecord());
  }

  /** id を採番して予約する（worktree の事前計算で agent-id を使いたい場合用）。 */
  reserveId(id?: string): string {
    return id && !this.agents.has(id) ? id : this.nextId();
  }

  /**
   * agent を spawn して registry に追加する。
   * worktree 由来の場合は branch / worktree メタを付与する（kill 時のクリーンアップに使う）。
   */
  spawn(cwd: string, handlers: AgentHandlers, opts?: SpawnOptions): Agent {
    const agentId = this.reserveId(opts?.id);
    // 固定エビは launch を明示で受け取る。動的エビはサーバ既定（spawnConfig）から構築する。
    const launch: LaunchParams = opts?.launch ?? {
      command: this.spawnConfig.command,
      args: this.spawnConfig.args,
      cwd,
      model: null,
    };
    const agent = new Agent(
      agentId,
      launch,
      this.spawnConfig,
      handlers,
      { kind: opts?.kind, pinned: opts?.pinned, role: opts?.role, notifySubscribe: opts?.notifySubscribe },
    );
    if (opts?.branch) agent.branch = opts.branch;
    if (opts?.worktreeRepo && opts?.worktreePath) {
      agent.worktreeRepo = opts.worktreeRepo;
      agent.worktreePath = opts.worktreePath;
    }
    this.agents.set(agentId, agent);
    void this.dump();
    return agent;
  }

  /**
   * worktree 由来 agent なら、その内部メタ（元 repo / worktree パス）を返す。
   * remove の前に呼んでおき、除去後にクリーンアップ（git worktree remove）するために使う。
   */
  worktreeMetaOf(id: string): WorktreeMeta | null {
    const agent = this.agents.get(id);
    if (!agent || !agent.worktreeRepo || !agent.worktreePath) return null;
    return { repo: agent.worktreeRepo, path: agent.worktreePath };
  }

  /** agent を kill して registry から除去する。 */
  remove(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    agent.kill();
    this.agents.delete(id);
    // 破棄した agent 宛の mailbox 状態（pending/購読待ち）も片付ける（届けようがないため）。
    this.mailbox?.clear(id);
    void this.dump();
    return true;
  }

  /** agent の接続モード（connected/isolated）を切り替える。成功なら true。 */
  setMode(id: string, mode: AgentMode): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    agent.mode = mode;
    void this.dump();
    return true;
  }

  /**
   * 宛先を解決して注入する（ルームモデルの中核）。
   *
   * 宛先解決と isolated ルール:
   * - `to === "all"`（@all ブロードキャスト）: **connected な agent のみ**へ配信。
   *   isolated はルーム疎通から外れているのでスキップする（拒否扱いにはしない）。
   * - 単体 id 宛: isolated でも **ユーザー由来（from === "user"）なら通す**。
   *   **他 agent 由来（from が agent id 等）なら拒否**し、送信元へ理由を返す。
   *   isolated = 他エビからの疎通を遮断、という意味を保つ。
   *
   * 各 agent の idle/busy キュー機構（Agent.inject）はそのまま使う。
   */
  resolveAndInject(to: string, from: string, message: string): InjectResult {
    const result: InjectResult = { delivered: [], rejected: [] };

    if (to === BROADCAST_TARGET) {
      // @all: connected な agent にだけ配信。isolated は黙ってスキップ。
      for (const agent of this.agents.values()) {
        if (agent.mode === "isolated") continue;
        this.deliver(agent.id, from, message);
        result.delivered.push(agent.id);
      }
      return result;
    }

    // 単体 id 宛。
    const agent = this.agents.get(to);
    if (!agent) {
      result.rejected.push({ id: to, reason: "注入先が見つかりません" });
      return result;
    }
    // isolated かつ他 agent 由来は遮断。ユーザー由来は通す。
    if (agent.mode === "isolated" && from !== "user") {
      result.rejected.push({
        id: to,
        reason: `isolated のため他エビ（${from}）からの注入を遮断しました`,
      });
      return result;
    }
    this.deliver(agent.id, from, message);
    result.delivered.push(agent.id);
    return result;
  }

  /**
   * 逆方向通知（reverse-notify）。エビ → master（将来は エビ間）への push 注入。
   *
   * 順方向 resolveAndInject が master/user → エビ なのに対し、こちらは from エビが
   * to（既定 master）へ自発的に届ける経路。本文に kind 由来のプレフィックス（[reply]/[idle]）を
   * 付けて、master 側が重要度を即判別できるようにする。
   *
   * 配送は既存 target.inject() をそのまま使う（master が busy なら injectQueue に積まれ、
   * idle 復帰時に flush される）。新たなキュー実装は不要。
   *
   * 安全ガード（設計書 §5）:
   * - from === to の自己送信ループは禁止。
   * - to が isolated なら受信拒否（隔離の意味を保つ）。
   * - kind:"reply"（明示リプライ）を受けたら from エビの lastReplyAt を更新し、
   *   直後の idle で B（idle 自動通知）を抑制する。
   *
   * @param to 宛先（当面 "master" 既定。将来 エビ間通知に拡張可能なよう引数化）
   */
  reverseInject(
    fromAgent: string,
    toAgent: string,
    message: string,
    kind: "reply" | "idle",
  ): InjectResult {
    const result: InjectResult = { delivered: [], rejected: [] };

    if (fromAgent === toAgent) {
      result.rejected.push({ id: toAgent, reason: "自己送信は禁止です" });
      return result;
    }

    const target = this.agents.get(toAgent);
    if (!target) {
      result.rejected.push({ id: toAgent, reason: `逆方向通知の宛先が見つかりません: ${toAgent}` });
      return result;
    }
    if (target.mode === "isolated") {
      result.rejected.push({ id: toAgent, reason: `${toAgent} は isolated のため逆方向通知を受信しません` });
      return result;
    }

    // kind:"reply" を受けたら from エビの「直近に明示リプライした時刻」を更新する
    // （直後の idle で B を抑制するため）。from が存在しなくても通知自体は通す。
    if (kind === "reply") this.agents.get(fromAgent)?.markReplied();

    this.deliver(toAgent, fromAgent, message, kind);
    result.delivered.push(toAgent);
    return result;
  }

  /** 内部状態が変わったら呼ぶ（status 変化など）。 */
  touch(): void {
    void this.dump();
  }

  /** 全 agent を kill（サーバ終了時）。 */
  killAll(): void {
    for (const agent of this.agents.values()) agent.kill();
    this.agents.clear();
  }

  /**
   * registry を JSON ファイルへダンプする。
   * 公開フィールド（AgentRecord）に加え、再アタッチ UI / 可観測性のために
   * 内部メタ（worktreeRepo/worktreePath）も含める。
   * ただしダンプから PTY を復元はしない（プロセスは生きている前提）。あくまで可観測性/将来用。
   */
  private async dump(): Promise<void> {
    try {
      await mkdir(dirname(this.dumpPath), { recursive: true });
      const snapshot = {
        dumpedAt: new Date().toISOString(),
        agents: [...this.agents.values()].map((a) => ({
          ...a.toRecord(),
          worktreeRepo: a.worktreeRepo,
          worktreePath: a.worktreePath,
        })),
      };
      await writeFile(this.dumpPath, JSON.stringify(snapshot, null, 2), "utf8");
    } catch (err) {
      // ダンプ失敗は致命ではないので警告のみ。
      console.warn("[registry] dump 失敗:", err);
    }
  }
}
