// [C] 最終報告の自動転送（final-report relay）。
//
// 直したい故障（2026-09-05 スモーク／2026-09-06 の武器画像ジョブで 3/3 再現）:
//   codex バックエンドの imagegen エビが、生成を全部終えたあと **reply_to_master を呼ばずに**
//   `imagegen_result: v1` の YAML を自分の TUI へ書いて idle になる。master には何も届かず、
//   ボスがナッジするまで止まる（ナッジすれば届く＝ツールは存在するし呼べる）。
//   実測の出典は docs/ops/codex-final-report-relay.md §1（vc-weapon-imagegen の scrollback）。
//
// 位置づけ:
//   既存の逆方向通知は [A] 明示リプライ（reply_to_master）と [B] idle 自動通知の 2 段だが、
//   - [A] は codex の指示追従に依存する（実測で落ちる）
//   - [B] は本文を持たない「待機に入りました」通知で、しかも `npm start` が
//     `EBI_IDLE_NOTIFY=off` で常用しているため本番では効いていない
//   ので、**本文ごと拾う保険**として [C] を足す。busy→idle のエッジで、そのターンに
//   出力された scrollback から所定マーカーのブロックだけを切り出して master へ [reply] で送る。
//
// 誤配送を出さないための錠前（このモジュールの全部）:
//   1. マーカーは **行頭**（インデントのみ許容）で、その行が `imagegen_result: v1` **だけ**であること。
//      役割プロンプトのエコー（`... imagegen_result: v1 / job_id / summary / results: ...` の 1 行）は
//      行末が続くので当たらない。
//   2. 切り出したブロックに `job_id: <値>` が行頭で在ること。役割プロンプトのエコーでは
//      `job_id` にコロンが付かない（`/ job_id /`）ので、TUI の折返し位置がどこであっても当たらない。
//   3. ブロックは TUI の枠線・プロンプト行（`─ Worked for ...` / `› ...` / `• ...`）で必ず終端する。
//   いずれも test/finalReport.test.ts が実測文字列で錠前を掛けている。
//
// 依存ゼロの純関数だけを置く（時計も registry も PTY も知らない）。副作用は呼び出し側。

/** 転送対象の「最終報告」マーカー定義。 */
export interface FinalReportMarker {
  /** 識別子（ログ／通知に出す）。 */
  readonly id: string;
  /** ブロックの開始行（インデント除去後の行**全体**に対して照合する）。 */
  readonly start: RegExp;
  /** 切り出したブロックに必ず含まれていなければならない行（誤検知よけの第 2 の錠前）。 */
  readonly require: RegExp;
}

/**
 * 既定のマーカー集合。今は imagegen の報告様式（src/server/imagegen.ts が SoT）だけ。
 * 「所定のマーカーだけを転送する」ことが誤配送を抑える最大の担保なので、
 * 汎用の「最後の発言をそのまま送る」には**しない**。
 */
export const FINAL_REPORT_MARKERS: readonly FinalReportMarker[] = [
  {
    id: "imagegen_result",
    start: /^imagegen_result:\s*v1$/,
    require: /^job_id:\s*\S/m,
  },
];

/**
 * ブロックを終端させる TUI の装飾行（codex TUI の枠線・箇条・入力プロンプト）。
 * 実測（vc-weapon-imagegen）では YAML 直後に `─ Worked for 4m 07s ────…` が来る。
 */
const TUI_CHROME_RE = /^[─━│┃└┌├┤┬┴┼•›»▌⏵>]/;

/** 連続する空行がこの数に達したらブロックを終える（TUI の再描画で混ざる空白対策）。 */
const MAX_BLANK_RUN = 2;

/** 転送本文の上限（行数・文字数）。超えたら切って末尾に注記を足す。 */
const MAX_BLOCK_LINES = 400;
const MAX_BLOCK_CHARS = 12000;

/**
 * 走査する scrollback の末尾上限（文字）。報告はターンの最後に出るので末尾だけ見れば足りる。
 * codex は 1 ターンで数百 KB のエスケープを吐くため、上限を置かないと無駄に重い。
 */
export const FINAL_REPORT_SCAN_LIMIT = 512 * 1024;

/**
 * PTY 出力から ANSI/OSC を落として素文にする。
 *
 * CSI の終端は `[@-~]` で、**中間バイト（0x20-0x2F）を挟む形**がある（codex TUI が毎フレーム
 * 吐くカーソル形状指定 `ESC [ 0 <space> q` がこれ）。既存の簡易版（`\x1b\[[0-9;?]*[a-zA-Z]`）は
 * これを取りこぼし、素文に `ESC[0 q` の残骸が挟まって行照合が全滅する（実測で確認済み）ため、
 * ここでは仕様どおりの CSI 文法で落とす。
 */
export function stripAnsi(raw: string): string {
  return raw
    // OSC（`ESC ] ... BEL` / `ESC ] ... ESC \`）。codex はタイトル更新に多用する。
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI（パラメータバイト → 中間バイト → 終端バイト）。
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // 文字集合指定（`ESC ( B` 等）と単独の 2 文字エスケープ。
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .replace(/\x1b[=>]/g, "");
}

/** 切り出した最終報告。 */
export interface FinalReport {
  /** 当たったマーカー id。 */
  readonly markerId: string;
  /** インデントを揃え直した報告本文（マーカー行を含む）。 */
  readonly body: string;
  /** 上限で切り詰めたか。 */
  readonly truncated: boolean;
}

/** 行頭の空白数。 */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * PTY 出力（生）から最終報告ブロックを切り出す。見つからなければ null。
 *
 * 同じマーカーが複数回描画されている場合は **後ろから**探し、最初に検証を通ったものを返す
 * （再描画で壊れた古い断片より、最後に描かれたものを採る）。
 */
export function extractFinalReport(
  raw: string,
  markers: readonly FinalReportMarker[] = FINAL_REPORT_MARKERS,
): FinalReport | null {
  if (raw.length === 0) return null;
  const scanned = raw.length > FINAL_REPORT_SCAN_LIMIT ? raw.slice(-FINAL_REPORT_SCAN_LIMIT) : raw;
  const lines = stripAnsi(scanned)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const marker = markers.find((m) => m.start.test(trimmed));
    if (!marker) continue;
    const report = cutBlock(lines, i, marker);
    if (report) return report;
  }
  return null;
}

/** マーカー行 startIdx からブロックを切り出して検証する。通らなければ null。 */
function cutBlock(
  lines: readonly string[],
  startIdx: number,
  marker: FinalReportMarker,
): FinalReport | null {
  const baseIndent = indentOf(lines[startIdx]!);
  const picked: string[] = [lines[startIdx]!.slice(baseIndent)];
  let blankRun = 0;
  let truncated = false;

  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      blankRun += 1;
      if (blankRun >= MAX_BLANK_RUN) break;
      picked.push("");
      continue;
    }
    blankRun = 0;
    // 装飾行（枠線・入力プロンプト）に当たったらそこで終わり。
    if (TUI_CHROME_RE.test(line.trim())) break;
    // マーカーより浅い行は「ブロックの外」。
    if (indentOf(line) < baseIndent) break;
    picked.push(line.slice(baseIndent));
    if (picked.length >= MAX_BLOCK_LINES) {
      truncated = true;
      break;
    }
  }

  // 末尾の空行を落とす。
  while (picked.length > 0 && picked[picked.length - 1]!.trim() === "") picked.pop();
  let body = picked.join("\n");
  if (!marker.require.test(body)) return null;
  if (body.length > MAX_BLOCK_CHARS) {
    body = body.slice(0, MAX_BLOCK_CHARS);
    truncated = true;
  }
  if (truncated) body += "\n…（長すぎるため打ち切り。全文は read_scrollback で読めます）";
  return { markerId: marker.id, body, truncated };
}

/**
 * master へ送る転送本文を組み立てる（reverseInject の kind:"reply" に渡す）。
 * 「本人がツールを呼ばなかったので**サーバが**拾って送った」と master が分かる形にする
 * （エビ本人の言葉として扱われると、次の依頼で同じ手抜きが正解として学習されるため）。
 */
export function buildFinalReportRelayText(agentId: string, report: FinalReport): string {
  return (
    `[自動転送] ${agentId} が reply_to_master を呼ばずにターンを終えたため、` +
    `セッション出力から最終報告（${report.markerId}）を拾って転送します。` +
    `本人の発言そのままではないので、疑わしければ read_scrollback で確認してください。\n` +
    report.body
  );
}

/** `off` / `0` / `false` を無効とみなす（EBI_IDLE_NOTIFY と同じ判定）。 */
export function isRelayEnabled(value: string | undefined): boolean {
  return !["off", "0", "false"].includes((value ?? "on").toLowerCase());
}
