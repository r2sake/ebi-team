// 依存ゼロの軽量 markdown パーサ（純粋関数・DOM 非依存）。
//
// 設計方針:
// - 一般的な md プレビュー程度の表現（見出し h1-h6 / 箇条書き・番号リスト / コードブロック /
//   インライン code / bold / italic / 引用 / 水平線 / 表 / リンク）をカバーする。
// - **DOM を触らない**（この関数は Node の単体テストからも import される）。出力は
//   純粋なブロック/インライン AST。実際の DOM 構築は viewer.ts が createElement/textContent で行う。
// - XSS 安全: md 中の生 HTML（`<script>` 等）は特別扱いせず **text ノード**として返す。
//   viewer.ts が text を textContent で描画するため、タグは文字列として表示される（実行されない）。

/** インライン要素の AST。 */
export type MdInline =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "strong"; children: MdInline[] }
  | { type: "em"; children: MdInline[] }
  | { type: "link"; text: string; href: string };

/** ブロック要素の AST。 */
export type MdBlock =
  | { type: "heading"; level: number; children: MdInline[] }
  | { type: "paragraph"; children: MdInline[] }
  | { type: "code"; lang: string | null; value: string }
  | { type: "list"; ordered: boolean; items: MdInline[][] }
  | { type: "blockquote"; children: MdBlock[] }
  | { type: "hr" }
  | { type: "table"; header: MdInline[][]; rows: MdInline[][][] };

/**
 * インライン文字列を AST へ分解する。
 * 優先順位: インライン code（内部を再解釈しない）> link > strong > em > text。
 * 特殊記号にマッチしない生 HTML タグ等はすべて text として積まれる（＝XSS 安全）。
 */
export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) {
      out.push({ type: "text", value: buf });
      buf = "";
    }
  };
  while (i < src.length) {
    const c = src[i];

    // インライン code: `...`（最短一致・内部は再解釈しない）。
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ type: "code", value: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // リンク: [text](href) （href に空白・) は含めない。任意のタイトル "..." は無視）。
    if (c === "[") {
      const m = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ type: "link", text: m[1], href: m[2] });
        i += m[0].length;
        continue;
      }
    }

    // strong: ** ... ** / __ ... __
    if ((c === "*" && src[i + 1] === "*") || (c === "_" && src[i + 1] === "_")) {
      const marker = c + c;
      const end = src.indexOf(marker, i + 2);
      if (end > i + 1) {
        flush();
        out.push({ type: "strong", children: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // em: * ... * / _ ... _
    if (c === "*" || c === "_") {
      const end = src.indexOf(c, i + 1);
      // 直後が空白の開始記号（`a * b`）は強調にしない簡易ガード。
      if (end > i + 1 && src[i + 1] !== " ") {
        flush();
        out.push({ type: "em", children: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

/** 行がテーブルの区切り行（| --- | :--: | 等）か。 */
function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
}

/** テーブル行を `|` 区切りセルに分解する（前後の空セルは落とす）。 */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/**
 * markdown 文字列をブロック AST へ分解する。
 * 行ベースの素朴な実装（ネストリスト等の複雑な構造は範囲外・一般的なプレビュー用途に十分）。
 */
export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行はスキップ。
    if (line.trim() === "") {
      i++;
      continue;
    }

    // コードフェンス ``` / ~~~
    const fence = /^(\s*)(```+|~~~+)(.*)$/.exec(line);
    if (fence) {
      const marker = fence[2][0];
      const lang = fence[3].trim() || null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker === "`" ? "```+" : "~~~+"}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // 閉じフェンスを消費（無くても EOF で抜ける）。
      blocks.push({ type: "code", lang, value: body.join("\n") });
      continue;
    }

    // ATX 見出し #〜######
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].replace(/\s+#+\s*$/, ""); // 末尾の閉じ # を除去。
      blocks.push({ type: "heading", level, children: parseInline(text) });
      i++;
      continue;
    }

    // 水平線 --- / *** / ___
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // 引用 >
    if (/^\s*>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        inner.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", children: parseMarkdown(inner.join("\n")) });
      continue;
    }

    // テーブル: ヘッダ行（| を含む）＋ 次行が区切り行。
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line).map(parseInline);
      i += 2;
      const rows: MdInline[][][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitTableRow(lines[i]).map(parseInline));
        i++;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    // リスト（箇条書き - * + / 番号 1.）
    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listItem) {
      const ordered = /\d/.test(listItem[2]);
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        // 同種（ordered/unordered）が続く間だけ 1 つのリストにまとめる。
        if (/\d/.test(m[2]) !== ordered) break;
        items.push(parseInline(m[3]));
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // 段落: 次の空行 or ブロック開始まで集める。
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i], lines[i + 1])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", children: parseInline(para.join("\n")) });
  }

  return blocks;
}

/** 段落の途中で別ブロックが始まるか（段落の切れ目判定）。 */
function isBlockStart(line: string, next: string | undefined): boolean {
  if (/^(\s*)(```+|~~~+)/.test(line)) return true;
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) return true;
  if (/^\s*>/.test(line)) return true;
  if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) return true;
  if (line.includes("|") && next !== undefined && isTableSeparator(next)) return true;
  return false;
}
