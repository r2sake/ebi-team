// env ファイル（KEY=VALUE の行形式）を「値を見せずに」扱うための純関数群。
//
// ファイル編集機能（src/server/fileEditor.ts / src/client/fileEditor.ts）で使う。
// - master の request_file_edit は「どの鍵を入れてほしいか」だけを指定し、値はボスが UI で入れる。
//   UI はこのモジュールで既存の本文へ鍵を差し込み、差分を伏せ字で見せてから保存する。
// - DOM にも fs にも依存しない（node の unit テストからそのまま検証する）。

/** 鍵名として受け付ける形（シェルの変数名と同じ）。 */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `KEY=VALUE` / `export KEY=VALUE` の 1 行を読む正規表現（前後の空白は許す）。 */
const ASSIGN_RE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;

/** 伏せ字に使う文字列（長さを漏らさないよう固定長）。 */
export const MASK = "••••••••";

/** 鍵名として正しいか。 */
export function isValidEnvKey(key: string): boolean {
  return KEY_RE.test(key);
}

/** 本文に代入行として現れる鍵名の集合（コメント行は数えない）。 */
export function envKeysPresent(content: string): Set<string> {
  const out = new Set<string>();
  for (const line of content.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const m = ASSIGN_RE.exec(line);
    if (m) out.add(m[2]!);
  }
  return out;
}

/**
 * 値を env 行の右辺として書ける形にする。
 * - 安全な文字だけなら素のまま
 * - それ以外は単引用符で囲む（`$` や空白をシェルに解釈させない）。単引用符を含むときだけ二重引用符
 * 改行は 1 行の env として書けないので throw する（呼び出し側で入力エラーにする）。
 */
export function quoteEnvValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("値に改行は入れられません");
  if (/^[A-Za-z0-9_\-.:/@+=,~%]*$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
}

/**
 * 本文へ鍵の値を差し込んだ新しい本文を返す。
 * - 既にある鍵は**最初の代入行**の右辺だけを置き換える（`export ` や `=` まわりの書き方は保つ）
 * - 無い鍵は末尾に `KEY=VALUE` で足す（末尾改行が無ければ補う）
 * - values に入っていない鍵には触らない（空文字の値は「空にする」意味で書き込む）
 * 鍵名が不正・値に改行がある場合は throw する。
 */
export function applyEnvValues(content: string, values: Readonly<Record<string, string>>): string {
  for (const key of Object.keys(values)) {
    if (!isValidEnvKey(key)) throw new Error(`鍵名が不正です: ${key}`);
  }
  const pending = new Map(Object.entries(values));
  const lines = content === "" ? [] : content.split("\n");
  // 末尾改行で split すると最後に空要素ができる。足す位置を正しくするため外しておく。
  const hadTrailingNewline = content.endsWith("\n");
  if (hadTrailingNewline) lines.pop();

  const out = lines.map((line) => {
    if (/^\s*#/.test(line)) return line;
    const m = ASSIGN_RE.exec(line);
    if (!m) return line;
    const key = m[2]!;
    if (!pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${m[1]}${key}${m[3]}${quoteEnvValue(value)}`;
  });
  for (const [key, value] of pending) out.push(`${key}=${quoteEnvValue(value)}`);
  if (out.length === 0) return "";
  return `${out.join("\n")}\n`;
}

/**
 * 1 行を伏せ字にする（差分表示・本文の伏せ字表示に使う）。
 * - 代入行は鍵名を残して右辺だけ伏せる（空の値は空のまま＝「未設定」と分かるように）
 * - コメント行・空行はそのまま（値を含まない前提）
 * - それ以外の行は丸ごと伏せる（形式の分からない行に秘密が入っていることがあるため）
 */
export function maskLine(line: string): string {
  if (line.trim() === "" || /^\s*#/.test(line)) return line;
  const m = ASSIGN_RE.exec(line);
  if (m) return m[4]!.trim() === "" ? line : `${m[1]}${m[2]}${m[3]}${MASK}`;
  return MASK;
}

/** 本文全体を伏せ字にする。 */
export function maskContent(content: string): string {
  return content.split("\n").map(maskLine).join("\n");
}
