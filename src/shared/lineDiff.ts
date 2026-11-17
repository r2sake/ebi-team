// 行単位の差分（上書き前の確認表示用）。
//
// ファイル編集機能（src/client/fileEditor.ts）が「保存すると何が変わるか」をボスに見せるのに使う。
// 依存なしの LCS（最長共通部分列）で、変わった行の前後だけを残した表示用の行列を返す。
// DOM にも fs にも依存しない（node の unit テストからそのまま検証する）。

/** 差分 1 行。op は ' '（共通）/ '-'（消える）/ '+'（増える）/ '…'（省略した共通部分）。 */
export interface DiffLine {
  op: " " | "-" | "+" | "…";
  text: string;
}

/**
 * LCS の表を作る上限（行数の積）。これを超えると「全部消して全部足す」の粗い差分に落とす
 * （1MB 上限のファイルでも、表のメモリを数十 MB に抑えるため）。
 */
const MAX_CELLS = 4_000_000;

/** 末尾改行で split したときの空要素を落として行配列にする。 */
function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/** 2 つの本文の全行差分（共通行も含む・省略なし）。 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = toLines(before);
  const b = toLines(after);
  // 先頭と末尾の共通部分は表を作らずに剥がす（設定ファイルの 1 行変更がほとんどなので速い）。
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ op: " ", text }));

  if (midA.length * midB.length > MAX_CELLS) {
    for (const text of midA) out.push({ op: "-", text });
    for (const text of midB) out.push({ op: "+", text });
  } else {
    // lcs[i][j] = midA[i..] と midB[j..] の LCS 長（1 次元配列に詰める）。
    const n = midA.length;
    const m = midB.length;
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * w + j] =
          midA[i] === midB[j]
            ? lcs[(i + 1) * w + j + 1]! + 1
            : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ op: " ", text: midA[i]! });
        i += 1;
        j += 1;
      } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
        out.push({ op: "-", text: midA[i]! });
        i += 1;
      } else {
        out.push({ op: "+", text: midB[j]! });
        j += 1;
      }
    }
    for (; i < n; i += 1) out.push({ op: "-", text: midA[i]! });
    for (; j < m; j += 1) out.push({ op: "+", text: midB[j]! });
  }

  for (const text of a.slice(a.length - tail)) out.push({ op: " ", text });
  return out;
}

/**
 * 変わった行の前後 context 行だけを残す（離れた共通部分は 1 行の「…」に畳む）。
 * 変更が無ければ空配列を返す。
 */
export function compactDiff(lines: readonly DiffLine[], context = 2): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.op === " ") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k += 1) {
      keep[k] = true;
    }
  });
  if (!keep.some(Boolean)) return [];
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (skipped > 0) out.push({ op: "…", text: `（変更なし ${skipped} 行）` });
      skipped = 0;
      out.push(l);
    } else {
      skipped += 1;
    }
  });
  if (skipped > 0) out.push({ op: "…", text: `（変更なし ${skipped} 行）` });
  return out;
}

/** 差分の件数（増えた行・消えた行）。 */
export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === "+") added += 1;
    else if (l.op === "-") removed += 1;
  }
  return { added, removed };
}
