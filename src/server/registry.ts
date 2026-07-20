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

/**
 * notification 配送の到達確認（end-to-end ACK）待ちタイムアウト（ms）。
 * deliver() は mailbox へ push した後この時間だけブリッジからの ack を待ち、取れなければ
 * PTY 注入へ自動フォールバックする。ブリッジのローカル round-trip は通常 1s 未満なので、
 * これを超える＝ブリッジが死んでいる/転送できていない と判断してよい。env で調整可。
 */
const ACK_TIMEOUT_MS = Number(process.env.EBI_DELIVER_ACK_TIMEOUT_MS) || 5000;

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
 * 1 宛先への配送経路と到達確認の内訳。
 * - via: どの経路で配送したか
 *   - "notify": notification 経路で到達確認（ブリッジ ACK）が取れた
 *   - "pty-fallback": notify を試みたが ACK が取れず PTY 注入へ自動フォールバックした
 *   - "pty": 最初から PTY 注入（購読 live でない / notifySubscribe:false / EBI_INJECT_MODE=pty）
 *   - "none": agent 不在で配送できなかった
 * - confirmed: 相手セッション（の入力）へ到達したと確認できたか。
 *   notify は ACK 取得を、PTY は入力欄への注入成立をもって true とする（agent 不在時のみ false）。
 */
export interface DeliverOutcome {
  ok: boolean;
  via: "notify" | "pty-fallback" | "pty" | "none";
  confirmed: boolean;
}

/**
 * 注入の宛先解決結果。
 * - delivered: 実際に注入を行った agent id 一覧
 * - rejected: ルールにより拒否した宛先と理由（送信元への notice 表示用）
 * - details: 宛先ごとの配送経路・到達確認の内訳（delivered の意味を「到達確認済み or
 *   フォールバック済み」に正直化するための可観測情報。送信元 MCP へそのまま返る）
 */
export interface InjectResult {
  delivered: string[];
  rejected: { id: string; reason: string }[];
  details: { id: string; via: DeliverOutcome["via"]; confirmed: boolean }[];
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

  /**
   * 指定 id が mailbox 経由で「今」確実に届く状態か。
   * = notification 有効 かつ ブリッジの long-poll が直近に生きている（isLive）。
   *
   * 【重要】旧実装は everSubscribed（一度でも購読したか＝単調フラグ）で判定していたが、
   * それだと購読が過去に成立した相手（master 含む）宛は、その後ブリッジが死んでも永久に
   * notification 経路に載せ続け、黙って消えていた（master 宛全損の直接原因）。現在の
   * liveness（直近 long-poll 接続あり）に置き換え、死んだ購読へは載せない。
   */
  hasActiveSubscriber(id: string): boolean {
    return this.notifyEnabled() && (this.mailbox?.isLive(id) ?? false);
  }

  /**
   * ブリッジからの到達確認（end-to-end ACK）を mailbox へ渡す。
   * 制御API `/control/ack` から呼ばれる。notify 無効/mailbox 未設定なら no-op。
   */
  ackDelivery(id: string, msgIds: number[]): void {
    this.mailbox?.ack(id, msgIds);
  }

  /**
   * pending（未回収）メッセージの可視化スナップショット。黙って消えていないことの観測入口。
   * mailbox 未設定（PTY 専用構成）なら空配列。
   */
  pendingSnapshot(): { id: string; count: number; live: boolean; oldestAgeMs: number | null }[] {
    return this.mailbox?.pendingSnapshot() ?? [];
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
   * 統一配送（到達確認つき）:
   * 1. notification 経路が「今」生きている（isLive）なら mailbox へ push し、ブリッジからの
   *    end-to-end ACK を最大 ACK_TIMEOUT_MS 待つ。ACK が取れれば到達確認済み（via:"notify"）。
   * 2. ACK が取れなければ、まだ pending に居るメッセージを回収（二重配送防止）してから PTY
   *    注入へ自動フォールバックする（via:"pty-fallback"）。
   * 3. そもそも購読が live でない / notifySubscribe:false / notify 無効なら最初から PTY 注入
   *    （via:"pty"）。
   *
   * これにより「push しただけで delivered=true（実際は届かず黙って消える）」を根絶し、
   * delivered の意味を「到達確認済み or 確実な PTY 経路へ載せ替え済み」に正直化する。
   *
   * kind 指定時は本文へ [idle]/[reply] タグを付与する（reverseInject 用・resolveAndInject は未指定）。
   * agent が存在しなければ ok:false（via:"none"）を返す（呼び出し側で見つからない扱いにする）。
   */
  async deliver(
    id: string,
    from: string,
    message: string,
    kind?: "reply" | "idle",
  ): Promise<DeliverOutcome> {
    const agent = this.agents.get(id);
    if (!agent) return { ok: false, via: "none", confirmed: false };
    const body = kind === "idle" ? `[idle] ${message}` : kind === "reply" ? `[reply] ${message}` : message;
    // notifySubscribe:false のエビ（外部チャンネル待機セッション・受信 PTY 固定）は、たとえ
    // 何らかの理由で購読者として登録されていても notification 経路に載せない。自セッションに
    // ebi-control channel が無く notification が harness に黙って捨てられるため（全配送経路
    // ―inject_message / @all ブロードキャスト / reverseInject―で PTY 注入を強制する）。
    if (agent.notifySubscribe !== false && this.hasActiveSubscriber(id)) {
      const msgId = this.mailbox!.push(id, { from, message: body, kind: kind ?? "message", ts: Date.now() });
      const acked = await this.mailbox!.waitForAck(id, msgId, ACK_TIMEOUT_MS);
      if (acked) return { ok: true, via: "notify", confirmed: true };
      // ACK 取れず＝ブリッジが転送できていない可能性。まだ pending に残っていれば回収し、
      // PTY 注入へフォールバックする（回収できなくても＝既にブリッジが拾って emit 済みでも、
      // 取りこぼしの方が害が大きいので PTY にも載せて確実に届ける。多少の重複は許容）。
      this.mailbox!.take(id, msgId);
      console.warn(
        `[registry] ${id} 宛 notification の ACK が ${ACK_TIMEOUT_MS}ms 以内に取れず PTY 注入へフォールバック（from=${from}）`,
      );
      agent.inject(from, body);
      return { ok: true, via: "pty-fallback", confirmed: true };
    }
    agent.inject(from, body);
    return { ok: true, via: "pty", confirmed: true };
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
    // 未回収の pending があれば「配送できずに失われた」ことをログに出す（黙って消さない）。
    const dropped = this.mailbox?.clear(id) ?? [];
    if (dropped.length > 0) {
      console.warn(
        `[registry] ${id} を除去。未配送 ${dropped.length} 件を破棄: ` +
          dropped.map((m) => `[from:${m.from}] ${m.message.slice(0, 60)}`).join(" / "),
      );
    }
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
  async resolveAndInject(to: string, from: string, message: string): Promise<InjectResult> {
    const result: InjectResult = { delivered: [], rejected: [], details: [] };

    if (to === BROADCAST_TARGET) {
      // @all: connected な agent にだけ配信。isolated は黙ってスキップ。
      // 各配送は ACK 待ちを含むため並列で行う（宛先が多くても待ち時間を直列に積み上げない）。
      const targets = [...this.agents.values()].filter((a) => a.mode !== "isolated");
      const outcomes = await Promise.all(
        targets.map((a) => this.deliver(a.id, from, message)),
      );
      targets.forEach((a, i) => {
        const o = outcomes[i]!;
        result.delivered.push(a.id);
        result.details.push({ id: a.id, via: o.via, confirmed: o.confirmed });
      });
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
    const o = await this.deliver(agent.id, from, message);
    result.delivered.push(agent.id);
    result.details.push({ id: agent.id, via: o.via, confirmed: o.confirmed });
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
  async reverseInject(
    fromAgent: string,
    toAgent: string,
    message: string,
    kind: "reply" | "idle",
  ): Promise<InjectResult> {
    const result: InjectResult = { delivered: [], rejected: [], details: [] };

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

    const o = await this.deliver(toAgent, fromAgent, message, kind);
    result.delivered.push(toAgent);
    result.details.push({ id: toAgent, via: o.via, confirmed: o.confirmed });
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
