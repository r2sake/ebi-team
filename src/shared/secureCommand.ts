// セキュアモードの Bash コマンド判定（純関数・依存なし）。
//
// PreToolUse hook（src/mcp/secure-hook.ts）とテストの両方から使う。
// 目的は **事故防止**（うっかりの git push・本番反映・外部送信・秘密の読み出しを止める）であり、
// 悪意ある回避まで防ぐものではない（OS のサンドボックスは次の段階で足す）。
// そのため判定は「コマンド文字列のどこかに現れたら当てる」広めの正規表現にしてある。
// 誤検知（echo "git push" 等）は承認バブルが 1 回出るだけで、安全側に倒れる。

/** 判定結果。approval = ボスのチャット承認待ち / deny = 承認の余地なく止める。 */
export type SecureCommandVerdict =
  | { kind: "approval"; label: string }
  | { kind: "deny"; reason: string };

interface Rule {
  re: RegExp;
  label: string;
}

/**
 * ボスがチャットで承認すれば通すもの（git push・本番の操作）。
 * `npx wrangler` / `pnpm wrangler` も `\bwrangler\b` で当たる。
 */
const APPROVAL_RULES: readonly Rule[] = [
  // git push（`git -C dir push` / `git -c k=v push` / `git --no-pager push` も当てる）
  { re: /\bgit\s+(?:(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?)\s+)*push\b/, label: "git push" },
  { re: /\bgh\s+pr\s+merge\b/, label: "gh pr merge（マージ）" },
  { re: /\bwrangler\b[^\n;&|]*\b(?:deploy|publish)\b/, label: "wrangler deploy（本番反映）" },
  { re: /\bwrangler\b[^\n;&|]*\bsecret(?::bulk)?\s+(?:put|bulk|delete)\b/, label: "wrangler secret（本番の秘密の変更）" },
  { re: /\bwrangler\b[^\n;&|]*\bsecret:bulk\b/, label: "wrangler secret（本番の秘密の変更）" },
  { re: /\bwrangler\b[^\n;&|]*\s--remote\b/, label: "wrangler --remote（本番リソースの操作）" },
  // package.json の deploy 系スクリプト・deploy スクリプトの直叩き
  { re: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?deploy[\w:.-]*/, label: "deploy スクリプト（本番反映）" },
  { re: /(?:^|[\s/])deploy[\w-]*\.(?:mjs|cjs|js|ts|sh)\b/, label: "deploy スクリプト（本番反映）" },
];

/** 承認の余地なく止めるもの（外部送信・秘密の読み出し）。 */
const DENY_RULES: readonly { re: RegExp; reason: string }[] = [
  { re: /\bgh\s+(?:pr|issue)\s+comment\b/, reason: "gh での PR・issue へのコメント（外部送信）" },
  { re: /\bgh\s+pr\s+review\b/, reason: "gh での PR レビュー投稿（外部送信）" },
  { re: /discord(?:app)?\.com\/api\/webhooks/i, reason: "Discord への送信（外部送信）" },
  { re: /hooks\.slack\.com/i, reason: "Slack への送信（外部送信）" },
  { re: /slack\.com\/api\/chat\./i, reason: "Slack への送信（外部送信）" },
  // 秘密のファイル・ディレクトリへの言及（cat / grep / cp など読み出し全般を止める）
  {
    // process.env / import.meta.env（コード中の環境変数参照）は当てない。
    re: /(?:^|[\s'"=:<>/])[\w.-]*(?<!process|meta)\.env(?:\.(?!example\b|sample\b|template\b|dist\b)[\w-]+)?(?![\w.-])/,
    reason: ".env（秘密のファイル）への言及",
  },
  { re: /(?:^|[\s'"=:<>(/])\.dev\.vars\b/, reason: ".dev.vars（wrangler の秘密）への言及" },
  { re: /(?:~|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.secrets\b/, reason: "~/.secrets への言及" },
  { re: /(?:~|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.cloudflare\b/, reason: "~/.cloudflare への言及" },
  { re: /\.wrangler\/config\b/, reason: "wrangler の認証設定への言及" },
  { re: /\.claude\/channels\b/, reason: "~/.claude/channels への言及" },
];

/**
 * Bash のコマンド文字列を判定する。何にも当たらなければ null（＝通常どおり実行）。
 * deny を approval より先に見る（承認で外部送信を通す経路を作らない）。
 */
export function classifySecureCommand(command: string): SecureCommandVerdict | null {
  if (typeof command !== "string" || command.length === 0) return null;
  for (const r of DENY_RULES) {
    if (r.re.test(command)) return { kind: "deny", reason: r.reason };
  }
  for (const r of APPROVAL_RULES) {
    if (r.re.test(command)) return { kind: "approval", label: r.label };
  }
  return null;
}
