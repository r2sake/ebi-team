// 配送本文の行頭タグ（`[from:<id>#<msgId>] `）を組み立てる唯一の場所。
//
// 【2026-08-16 二重配送の根治（msgId タグ照合）】
// 配送は notification（channel）経路と PTY 注入経路の 2 本があり、宛先セッションには
// **同じ行頭タグ＋同じ本文**で見える必要がある。この 2 経路は別プロセス
// （notify = src/mcp/control-server.ts のブリッジ / PTY = src/server/agent.ts）で
// 文字列を組み立てているため、片方だけ書式を変えると「同じメッセージだと照合できない」
// ＝二重配送の抑止が静かに壊れる。実際、旧実装はタグ書式が 2 箇所へ手書きで散っていた。
// そこで **両経路がこの関数だけを使う**ことを不変条件にし、テストで錠前を掛ける
// （test/dupDelivery.test.ts「notify と PTY のタグ表記が完全一致する」）。
//
// msgId を含めるのは、到達照合（EchoGuard / confirmSessionEcho）の針をこのタグ
// **そのもの**にするため。旧実装は「本文の先頭 N 文字」を針にしていたが、claude TUI の
// channel 1 行描画は**表示カラム**（実測 80 桁端末で約 56 桁）で切り詰めるのに対し
// 針は**文字数**（既定 24）で作られていた。日本語は 1 文字 = 2 カラムなので実際に
// 描画されるのは本文 21〜23 文字しかなく、**和文メッセージでは針が原理的に届かない**
// ＝照合 100% 失敗 → ACK 済み（＝実際は届いている）notification にも必ず PTY 注入を
// 重ねていた（実測: echo-timeout 94 件に対し duplicate-suppressed 0 件）。
// タグは必ず行頭にあり切り詰めの影響を受けず、msgId で一意なので、本文の言語・長さ・
// 表示幅に一切依存せず「この配送が描画されたか」を判定できる。

/**
 * 配送本文の行頭に付くタグを返す（末尾スペース込み）。
 *
 * msgId があれば `[from:master#90] `、無ければ従来どおり `[from:master] `。
 * msgId が付くのは mailbox を経由した配送（notify とそのフォールバック）だけで、
 * PTY 専用経路（`via:"pty"` / inject_message の直送）は採番が無いため従来書式になる。
 * 後者は notification と競合しないので、照合の一意性を必要としない。
 *
 * 【照合の一意性】compact 後の針は `[from:master#90]` となり `]` で閉じるため、
 * msgId 9 の描画（`[from:master#9]`）が msgId 90 の針に一致することはない。
 */
export function deliveryTag(from: string, msgId?: number | null): string {
  return typeof msgId === "number" ? `[from:${from}#${msgId}] ` : `[from:${from}] `;
}

/** タグと本文を連結した「セッションに見える 1 通ぶんの全文」。両経路で必ずこれを使う。 */
export function deliveryText(from: string, body: string, msgId?: number | null): string {
  return `${deliveryTag(from, msgId)}${body}`;
}
