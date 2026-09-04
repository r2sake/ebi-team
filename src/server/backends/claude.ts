// Claude Code バックエンド実装。
//
// これまで index.ts / config.ts / agent.ts / registry.ts に散っていた「claude 固有の知識」
// （起動フラグ・--mcp-config / dev-channels の付与条件・インライン TUI env・起動ゲートの
// 文言と自動応答・制御MCP ブリッジ判定）を 1 箇所に集約したもの。
// 挙動は集約前と完全に同一（外形ゼロ差分）であること。

import { CLAUDE_TRAITS } from "./profiles.ts";
import type {
  BackendEnvInput,
  BackendLaunchInput,
  EbiBackend,
  StartupGateKind,
  StartupGateSpec,
} from "./types.ts";

/**
 * `--dangerously-load-development-channels` に渡す channel 指定子。
 * 手動設定の MCP サーバは `server:<mcpServersキー名>` 形式でタグ付けが必須
 * （素の "ebi-control" だと claude が起動時エラーで即終了する。実機で確認済み）。
 * キー名は gen-master-mcp.mjs の生成キー "ebi-control" と一致していること。
 */
export const EBI_CONTROL_MCP_NAME = "ebi-control";

/** 同上（`server:<mcpServersキー名>`）。キー名は ControlMcpSpec.name と同一 SoT。 */
export const EBI_CONTROL_CHANNEL_SPEC = `server:${EBI_CONTROL_MCP_NAME}`;

/**
 * 起動ゲート自動応答を許可する dev channel 値の「組込み（既定）許可リスト」。
 * ここに載っている**正確値**（完全一致）だけを自動応答対象にする。
 * ワイルドカード・前方一致・部分一致は一切しない（意図せぬ承認を防ぐ）。
 * 運用者が config（ebi-team.config.json の top-level "devChannelsAllowlist"）で
 * 追加の正確値を足せる（例: 外部チャンネル待機セッションの plugin:slack@<marketplace>）。
 * その追加分は index.ts が SpawnConfig.devChannelsAllowlist にマージして Agent に渡す。
 */
export const BASE_ALLOWED_DEV_CHANNELS: readonly string[] = ["server:ebi-control"];

const DEV_CHANNELS_FLAG = "--dangerously-load-development-channels";

/**
 * TUI を「代替スクリーン（alternate screen）」ではなく通常バッファへインライン描画させるための
 * 既定 env。ブラウザ側 xterm.js のスクロールバックを機能させるために必須。
 *
 * 背景（実測 claude 2.1.198）:
 * - claude CLI は起動直後に `ESC[?1049h`（代替スクリーン ON）＋ `ESC[?1000h/1002h/1006h`
 *   （マウストラッキング ON）を送り、セッション中 `ESC[?1049l` を送らない。
 * - 代替スクリーンでは xterm.js は **スクロールバックを一切持たない**（仕様）。さらにマウス
 *   トラッキング中はホイールが端末側スクロールではなくアプリへ転送される。
 *   結果、ブラウザのペインは「claude 内部ビューの見えている範囲」しか見られなくなり、
 *   /compact のような全画面再描画（内部ビューのリセット）が走ると過去ログを辿れなくなる。
 *   タッチ端末はホイールが無いためスクロール手段が完全に消える（既知バックログと同根）。
 * - `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` を与えると 1049/1000/1002/1006 を一切送らず、
 *   通常バッファへインライン追記する（実測で確認）。これで xterm.js の scrollback が効く。
 */
const INLINE_TUI_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
  // 代替スクリーン OFF なら現行版はマウス報告を送らないが、将来版でホイールを奪われないよう保険。
  CLAUDE_CODE_DISABLE_MOUSE: "1",
};

/**
 * spawn 引数を見て「起動ゲート（trust / dev-channels 警告）の自動応答を有効化してよいか」を判定する。
 *
 * 安全限定（正確値の許可リスト方式）: `--dangerously-load-development-channels` の値が
 * **1個以上あり、そのすべてが `allowlist` の正確値（完全一致）である**ときだけ true。
 * 許可リストに無い値が1つでも混ざる／フラグ自体が無い場合は false
 * （＝自動で危険確認を承認しない。設定書き換えによる意図せぬ承認を防ぐ）。
 * 照合は完全一致のみ。ワイルドカード・前方一致・部分一致は一切導入しない
 * （`plugin:slack@*` のような値は許可リストに正確一致しない限り必ず false）。
 *
 * `allowlist` 未指定時は組込みの BASE_ALLOWED_DEV_CHANNELS（server:ebi-control のみ）を使う。
 * 当該フラグは variadic（`<servers...>`）で、次の `--flag` までの全トークンを値として取る。
 */
export function isDevChannelsAutoAnswerEligible(
  args: readonly string[],
  allowlist: readonly string[] = BASE_ALLOWED_DEV_CHANNELS,
): boolean {
  const flagIdx = args.indexOf(DEV_CHANNELS_FLAG);
  if (flagIdx === -1) return false;
  const values: string[] = [];
  for (let i = flagIdx + 1; i < args.length; i++) {
    if (args[i].startsWith("--")) break;
    values.push(args[i]);
  }
  // 値が1個以上あり、そのすべてが許可リストに完全一致することを要求する。
  return values.length >= 1 && values.every((v) => allowlist.includes(v));
}

/**
 * 起動フェーズの対話ダイアログ種別を、素文スキャンバッファから判定する純関数。
 *
 * claude(Ink) TUI は単語間を空白でなくカーソル移動エスケープで描画するため、ANSI 除去後は
 * "Iamusingthisforlocaldevelopment" のように空白が消えることがある（TUI が空白なしで
 * 描画する既知の罠）。よって照合は**空白を全除去した文字列**に対して**空白なしパターン**で行う。
 * これにより空白あり／なしどちらの描画でも同じく検知できる。
 *
 * 戻り値:
 *  - "devChannels": development channels 警告（--dangerously-load-development-channels 使用時）
 *  - "trust": workspace trust 確認（初見 cwd）
 *  - null: どちらのダイアログも検知できない
 */
export function detectStartupGate(rawScanBuffer: string): StartupGateKind | null {
  const compact = rawScanBuffer.replace(/\s+/g, "");
  if (/Loadingdevelopmentchannels|localchanneldevelopment|Iamusingthisforlocaldevelopment/i.test(compact)) {
    return "devChannels";
  }
  if (/trustthisfolder|Isthisaprojectyou(created|trust)/i.test(compact)) {
    return "trust";
  }
  return null;
}

/**
 * Claude の起動ゲート定義。
 * 対象は 2 種（いずれも選択肢 1＝許可 を選んで Enter）:
 *  - development channels 警告（`--dangerously-load-development-channels` 使用時に必ず出る）
 *  - workspace trust 確認（初見 cwd のとき出る）
 */
const CLAUDE_STARTUP_GATES: StartupGateSpec = {
  kinds: ["devChannels", "trust"],
  baseAllowlist: BASE_ALLOWED_DEV_CHANNELS,
  // dev-channels ダイアログはセッションを入力待ちで沈黙させ、その沈黙を idle 検出器が拾って
  // ready へ誤昇格させる。応答が済むまで ready にしない。
  readyBlockingGate: "devChannels",
  isAutoAnswerEligible: isDevChannelsAutoAnswerEligible,
  detect: detectStartupGate,
  answerFor: () => "1\r",
  noticeFor: (kind) =>
    kind === "devChannels"
      ? `起動ゲート自動応答: development channels 警告に "1"+Enter を送信（許可リスト限定・ready 前）`
      : `起動ゲート自動応答: workspace trust 確認に "1"+Enter を送信（ready 前）`,
};

/** Claude Code バックエンド。 */
export const CLAUDE_BACKEND: EbiBackend = {
  // 性質（envDenyList / reportsUsage / idleThresholdMs / killProcessGroup / preflight /
  // initialPromptArgs）は profiles.ts が SoT。claude は全て「現状踏襲」の値。
  ...CLAUDE_TRAITS,

  id: "claude",
  defaultCommand: "claude",

  matches(command: string): boolean {
    return command === "claude" || command.endsWith("/claude");
  },

  /**
   * 起動引数の組み立て順（この順序は既存の外形と一致させること）:
   *   [--model M]? [--permission-mode P]? [--append-system-prompt S]?
   *   [--mcp-config C [--dangerously-load-development-channels server:ebi-control]?]?
   *   ...extraArgs
   *
   * --strict-mcp-config は付けない。作業に必要な既存 MCP 環境を保ちつつ ebi-control を
   * 「追加」で持たせたいため（strict だと他の MCP が落ちる）。
   * dev-channels フラグは notify モードのときだけ足す。これが無いと
   * `notifications/claude/channel` が harness の channels allowlist 判定で skip され、
   * notification 注入が成立しない（2026-07-11 harness バイナリ解析＋実機検証で確定。
   * capability 宣言は src/mcp/control-server.ts 側）。
   */
  buildArgs(input: BackendLaunchInput): string[] {
    const args: string[] = [];
    if (input.model) args.push("--model", input.model);
    if (input.permissionMode) args.push("--permission-mode", input.permissionMode);
    if (input.systemPrompt) args.push("--append-system-prompt", input.systemPrompt);
    if (input.mcpConfigPath) {
      args.push("--mcp-config", input.mcpConfigPath);
      if (input.notifyMode) args.push(DEV_CHANNELS_FLAG, EBI_CONTROL_CHANNEL_SPEC);
    }
    args.push(...input.extraArgs);
    return args;
  },

  /**
   * インライン TUI 描画のための既定 env。claude はこれ以外に env を必要としないので、
   * `inlineTui:false`（EBI_INLINE_TUI=off の非常口）なら空を返す
   * （従来 agent.ts 側で丸ごと落としていた挙動と同一。判断を backend へ移しただけ）。
   */
  buildEnv(input?: BackendEnvInput): Record<string, string> {
    if (input?.inlineTui === false) return {};
    return { ...INLINE_TUI_ENV };
  },

  // Claude harness 独自の `notifications/claude/channel` に対応する。
  supportsChannelInject: true,

  /**
   * 起動引数に --mcp-config があれば制御MCP ブリッジ持ち（役割付き動的エビ・master 固定エビ）。
   * spawn 直後にまだ初回 subscribe が来ていない相手を「待つ価値があるか」の事前判定に使う。
   */
  hasControlBridge(args: readonly string[]): boolean {
    return args.includes("--mcp-config");
  },

  startupGates: CLAUDE_STARTUP_GATES,

  // claude はインタラクティブ起動で位置引数のプロンプトを取らない運用にしている。
  supportsInitialPrompt: false,
};
