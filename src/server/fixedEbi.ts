// 固定エビ（master/supervisor）の自動起動・自動再起動マネージャ。
//
// 設計方針:
// - サーバ起動時に config の固定エビを順に spawn する。
// - 固定エビが exit したら自動再起動する（指数バックオフ）。
//   短時間に連続失敗（crashloop）したら再起動を止め、notice/ログで知らせる（無限ループ防止）。
// - ユーザーが意図的に停止したい場合に備え、stop() で監視を解除できる（サーバ終了時）。

import type { Registry } from "./registry.ts";
import type { AgentHandlers } from "./agent.ts";
import type { FixedEbiSpec } from "./config.ts";
import { logFixedEbi } from "./fixedEbiLog.ts";

/**
 * master の固定エビに役割別 MCP config（--strict-mcp-config --mcp-config <path>）を自動付与する。
 *
 * 背景（2026-08-12 の master 起動不能インシデント）: master だけが config 手書きで
 * `--mcp-config .../master-control.dev.mcp.json` を持っており、`npm start`（本番・非 dev の
 * ファイル名で生成）では実在しないパスを指して claude が起動直後に死んでいた。engineer 側は
 * index.ts の defaultMcpConfigPath() が dev/本番を自動判定して付与しているので、master も
 * 同じ仕組みに寄せる＝config からパスを消し、サーバが spawn 時に解決したパスを付ける。
 *
 * - kind が master 以外、または claude 以外の command（テストの bash 等）には何もしない。
 * - args に既に `--mcp-config` があるときは手動指定を尊重して何もしない（上書きの余地を残す）。
 * - `--strict-mcp-config` は既にあれば重複させない。
 */
export function applyMasterMcpConfig(spec: FixedEbiSpec, mcpConfigPath: string): FixedEbiSpec {
  if (spec.kind !== "master") return spec;
  const { command, args } = spec.launch;
  const isClaude = command === "claude" || command.endsWith("/claude");
  if (!isClaude) return spec;
  if (args.includes("--mcp-config")) return spec;
  const extra = args.includes("--strict-mcp-config")
    ? ["--mcp-config", mcpConfigPath]
    : ["--strict-mcp-config", "--mcp-config", mcpConfigPath];
  return { ...spec, launch: { ...spec.launch, args: [...args, ...extra] } };
}

/** crashloop 判定・バックオフのパラメータ。 */
export interface RestartPolicy {
  /** 初回バックオフ（ms）。以降 2 倍ずつ増やす。 */
  baseDelayMs: number;
  /** バックオフ上限（ms）。 */
  maxDelayMs: number;
  /**
   * crashloop とみなす連続失敗回数。
   * 「短命（minHealthyMs 未満で死ぬ）」が この回数連続したら再起動を停止する。
   */
  maxConsecutiveFailures: number;
  /**
   * これ以上生存したら「正常に動いた」とみなし、連続失敗カウンタをリセットする閾値（ms）。
   */
  minHealthyMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxConsecutiveFailures: 5,
  minHealthyMs: 10_000,
};

/** 1 体の固定エビの再起動状態。 */
interface Supervised {
  spec: FixedEbiSpec;
  /** 連続短命失敗カウンタ。minHealthyMs 以上生存でリセット。 */
  consecutiveFailures: number;
  /** 直近 spawn 時刻（生存時間の計測用）。 */
  lastSpawnAt: number;
  /** 予約中の再起動タイマ。 */
  timer: NodeJS.Timeout | null;
  /** crashloop で停止したか。 */
  stopped: boolean;
}

export class FixedEbiManager {
  private readonly supervised = new Map<string, Supervised>();
  /** マネージャ自体が停止済みか（サーバ終了時）。これ以降の再起動を抑止する。 */
  private shuttingDown = false;

  constructor(
    private readonly registry: Registry,
    private readonly policy: RestartPolicy = DEFAULT_RESTART_POLICY,
  ) {}

  /** この id が固定エビとして管理対象か。 */
  manages(id: string): boolean {
    return this.supervised.has(id);
  }

  /**
   * config の固定エビを順に起動して監視下に置く。
   * 既に同 id がある場合はスキップ（多重起動防止）。
   */
  start(specs: FixedEbiSpec[], handlers: AgentHandlers): void {
    for (const spec of specs) {
      if (this.supervised.has(spec.id)) continue;
      if (this.registry.has(spec.id)) continue;
      const s: Supervised = {
        spec,
        consecutiveFailures: 0,
        lastSpawnAt: 0,
        timer: null,
        stopped: false,
      };
      this.supervised.set(spec.id, s);
      this.spawnNow(s, handlers);
    }
  }

  /** 監視を全停止し、予約中の再起動タイマを破棄する（サーバ終了時）。 */
  stop(): void {
    this.shuttingDown = true;
    for (const s of this.supervised.values()) {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
    }
  }

  /**
   * 固定エビが exit/kill されたときに呼ぶ。再起動を予約する（crashloop 時を除く）。
   * index.ts の onExit / kill 拒否解除フローから呼ばれる。
   */
  onExit(id: string, handlers: AgentHandlers): void {
    if (this.shuttingDown) return;
    const s = this.supervised.get(id);
    if (!s || s.stopped) return;

    const aliveMs = Date.now() - s.lastSpawnAt;
    if (aliveMs >= this.policy.minHealthyMs) {
      // 十分生きていたので「正常稼働の後の終了」とみなし、失敗カウンタをリセット。
      s.consecutiveFailures = 0;
    } else {
      s.consecutiveFailures += 1;
      // 短命死は「起動引数が壊れている」ことの最有力サイン。PTY ごと消える（タイルが残らない）
      // ため、ここで恒久ログに残しておかないと事後に何も辿れない。
      logFixedEbi({
        event: "short-lived-exit",
        msg:
          `固定エビ "${id}" が起動 ${aliveMs}ms で終了しました` +
          `（連続 ${s.consecutiveFailures}/${this.policy.maxConsecutiveFailures} 回目）`,
        id,
        aliveMs,
        consecutiveFailures: s.consecutiveFailures,
        command: s.spec.launch.command,
        args: s.spec.launch.args,
        cwd: s.spec.launch.cwd,
      });
    }

    if (s.consecutiveFailures >= this.policy.maxConsecutiveFailures) {
      s.stopped = true;
      handlers.onNotice(
        id,
        `固定エビ "${id}" が短時間に ${s.consecutiveFailures} 回連続で終了したため` +
          `自動再起動を停止しました（crashloop 防止）。設定を確認してください。`,
      );
      // console だけだと事後に追えないため恒久ログにも残す（console 出力もこの中で行う）。
      logFixedEbi({
        event: "crashloop-stopped",
        msg:
          `固定エビ "${id}" が短時間（各 ${this.policy.minHealthyMs}ms 未満）に ` +
          `${s.consecutiveFailures} 回連続で終了したため自動再起動を停止しました。` +
          `起動引数・MCP config のパスを確認してください`,
        id,
        consecutiveFailures: s.consecutiveFailures,
        command: s.spec.launch.command,
        args: s.spec.launch.args,
        cwd: s.spec.launch.cwd,
      });
      return;
    }

    // 指数バックオフ（連続失敗回数に応じて遅延を増やす）。
    const exp = Math.max(0, s.consecutiveFailures - 1);
    const delay = Math.min(this.policy.baseDelayMs * 2 ** exp, this.policy.maxDelayMs);
    handlers.onNotice(id, `固定エビ "${id}" を ${delay}ms 後に自動再起動します`);
    s.timer = setTimeout(() => {
      s.timer = null;
      if (this.shuttingDown || s.stopped) return;
      this.spawnNow(s, handlers);
    }, delay);
  }

  /** 即時 spawn（初回起動・再起動共通）。 */
  private spawnNow(s: Supervised, handlers: AgentHandlers): void {
    s.lastSpawnAt = Date.now();
    try {
      // EBI_ID を pty env に注入する（statusLine が usage を /control/usage へ POST する際の
      // 識別子。固定エビ master/supervisor も対象にする）。config 由来の env は無いので新規に付ける。
      const launch = {
        ...s.spec.launch,
        env: { ...(s.spec.launch.env ?? {}), EBI_ID: s.spec.id },
      };
      this.registry.spawn(launch.cwd, handlers, {
        id: s.spec.id,
        kind: s.spec.kind,
        pinned: true,
        launch,
        notifySubscribe: s.spec.notifySubscribe,
      });
      // 起動も記録する（解決済み args を残す＝MCP config パス等の事後検証がログだけで済む）。
      logFixedEbi({
        event: "spawned",
        level: "info",
        msg:
          `起動: ${s.spec.id} (${s.spec.kind}) ` +
          `model=${s.spec.launch.model ?? "-"} cwd=${s.spec.launch.cwd}`,
        id: s.spec.id,
        kind: s.spec.kind,
        command: s.spec.launch.command,
        args: s.spec.launch.args,
        cwd: s.spec.launch.cwd,
      });
    } catch (err) {
      // spawn 自体の失敗も「失敗」として扱い、再起動フローに乗せる。
      logFixedEbi({
        event: "spawn-failed",
        msg: `固定エビ "${s.spec.id}" の spawn に失敗: ${(err as Error).message}`,
        id: s.spec.id,
        command: s.spec.launch.command,
        args: s.spec.launch.args,
        cwd: s.spec.launch.cwd,
        stack: (err as Error).stack,
      });
      handlers.onNotice(s.spec.id, `固定エビ "${s.spec.id}" の起動に失敗: ${(err as Error).message}`);
      // exit イベントは来ないので、ここで明示的に再起動判定を回す。
      this.onExit(s.spec.id, handlers);
    }
  }
}
