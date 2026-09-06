// [C] 最終報告の自動転送（final-report relay）の純関数テスト。
//
// 対象:
//   1. ANSI 除去（codex TUI が毎フレーム吐く `ESC [ 0 <space> q`＝中間バイト付き CSI を落とせるか）
//   2. 実測どおりの scrollback から imagegen_result ブロックを丸ごと切り出せるか
//   3. 誤検知しないこと（役割プロンプトのエコー・依頼 YAML・報告の話をしているだけの文）
//   4. TUI の枠線／入力プロンプトでブロックが終端すること
//   5. 転送本文が「サーバが拾った」と分かる形か
//
// 出典（実測）: 2026-09-06 の武器画像ジョブ vc-weapon-imagegen の scrollback。
// 生の断片は `ESC[0 q` と OSC タイトル更新が YAML の行末に大量に挟まっており、
// 素朴な ANSI 除去（`\x1b\[[0-9;?]*[a-zA-Z]`）では `[0 q` が残って行照合が全滅する。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFinalReportRelayText,
  extractFinalReport,
  isRelayEnabled,
  stripAnsi,
} from "../src/server/finalReport.ts";

/** codex TUI が毎フレーム吐くカーソル形状指定（CSI・中間バイト付き）。 */
const CURSOR_SHAPE = "\x1b[0 q";
/** タイトル更新（OSC）。スピナーのコマが入る。 */
const OSC_TITLE = "\x1b]0;⠹ ebi-team\x07";
/** 色指定（SGR）。 */
const SGR = "\x1b[48;2;30;30;30m";

/**
 * 実測どおりの「YAML 1 行ぶんの生出力」を作る。
 * 行頭にインデント、行末にカーソル形状指定とタイトル更新がぶら下がる。
 */
function ptyLine(text: string): string {
  return `${SGR}${text}${CURSOR_SHAPE}${CURSOR_SHAPE}${OSC_TITLE}\r\n`;
}

/** 実測の報告ブロック（14 枚のうち 2 枚に縮めたもの。構造は原文どおり）。 */
const REPORT_LINES = [
  "  imagegen_result: v1",
  "  job_id: guild-rpg-weapons",
  '  summary: "13/14枚が正方形・アルファ有り。bow_yew は累計6試行すべてアルファ欠落。"',
  "  results:",
  "    - id: sword",
  "      status: ok",
  "      path: /Users/yoimaro/workspace/GitHub/ebi-team/tmp/images/guild-rpg-weapons/sword.png",
  "      pixels: 1254x1254",
  "      bytes: 471685",
  "      format: png",
  "      tool: image_gen__imagegen",
  '      note: "alpha: true; attempts: 1"',
  "    - id: bow_yew",
  "      status: failed",
  "      error_code: GEN_ERROR",
  '      note: "アルファ欠落。RGB で返る。"',
  "  gen_seconds: 65.6",
];

/** 実測の並び: 直前に作業ログ、直後に「Worked for …」の枠線とプロンプト行が来る。 */
const REAL_SCROLLBACK =
  ptyLine("• Ran python3 - <<'PY'") +
  ptyLine("  │ from PIL import Image") +
  ptyLine("  └ (1254, 1254) RGB None") +
  ptyLine("• bow_yew は追加3試行もすべて RGB でした。13枚は合格を維持しました。") +
  ptyLine("") +
  REPORT_LINES.map(ptyLine).join("") +
  ptyLine("─ Worked for 4m 07s ────────────────────────────────────────") +
  ptyLine("› Run /review on my current changes gpt-5.6-sol default · ~/workspace/GitHub/ebi-team");

/**
 * 稼働 config の imagegen 役割プロンプト（報告様式を説明している部分）。
 * ready 後の PTY 注入で TUI がそのままエコーするため、走査バッファに必ず入る。
 */
const ROLE_PROMPT_ECHO =
  "【報告】本文は 1 行サマリと次の YAML ブロック 1 個。" +
  "imagegen_result: v1 / job_id / summary / results: 各要素は id, status(ok|failed|refused|skipped), " +
  "path(絶対パス), pixels(sips の実測値), bytes, format, tool, error_code?, note? / gen_seconds。" +
  "path は必ず絶対パスにし（master が open_viewer にそのまま渡す）、pixels は依頼値ではなく実測値を書く。";

test("stripAnsi: 中間バイト付き CSI（ESC[0 q）と OSC を落とす", () => {
  const raw = `${SGR}  job_id: abc${CURSOR_SHAPE}${OSC_TITLE}`;
  assert.equal(stripAnsi(raw), "  job_id: abc");
  // 素朴な実装が取りこぼす形（残骸が 1 文字も残らないこと）。
  assert.equal(stripAnsi(CURSOR_SHAPE), "");
  assert.ok(!stripAnsi(REAL_SCROLLBACK).includes("\x1b"));
});

test("実測 scrollback から imagegen_result ブロックを丸ごと切り出せる", () => {
  const report = extractFinalReport(REAL_SCROLLBACK);
  assert.notEqual(report, null);
  assert.equal(report!.markerId, "imagegen_result");
  assert.equal(report!.truncated, false);
  // インデントが揃え直され、マーカー行から gen_seconds まで欠けずに入る。
  const lines = report!.body.split("\n");
  assert.equal(lines[0], "imagegen_result: v1");
  assert.equal(lines[1], "job_id: guild-rpg-weapons");
  assert.equal(lines[lines.length - 1], "gen_seconds: 65.6");
  assert.equal(lines.length, REPORT_LINES.length);
  // results の入れ子インデントは相対関係が保たれる（master がそのまま YAML として読める）。
  assert.ok(report!.body.includes("\n  - id: sword\n    status: ok\n"));
});

test("TUI の枠線・入力プロンプトでブロックが終端する（作業ログを巻き込まない）", () => {
  const report = extractFinalReport(REAL_SCROLLBACK);
  assert.ok(!report!.body.includes("Worked for"));
  assert.ok(!report!.body.includes("Run /review"));
  assert.ok(!report!.body.includes("Ran python3"));
});

test("誤検知しない: 役割プロンプトのエコー（折返し位置によらず）", () => {
  // 注入エコーは TUI の幅で折り返される。どの幅で折っても当たらないこと。
  for (const width of [40, 56, 64, 72, 80, 100, 120]) {
    const wrapped = ROLE_PROMPT_ECHO.match(new RegExp(`.{1,${width}}`, "gs")) ?? [];
    const raw = wrapped.map((l) => ptyLine(`  ${l}`)).join("");
    assert.equal(
      extractFinalReport(raw),
      null,
      `幅 ${width} の折返しで役割プロンプトが誤検知されました`,
    );
  }
});

test("誤検知しない: 依頼 YAML（imagegen_job）と、報告の話をしているだけの文", () => {
  const job =
    ptyLine("  imagegen_job: v1") +
    ptyLine("  job_id: guild-rpg-weapons") +
    ptyLine("  images:") +
    ptyLine("    - id: sword");
  assert.equal(extractFinalReport(job), null);

  const chat =
    ptyLine("• 生成が終わったので imagegen_result: v1 の YAML を作ってから報告します。") +
    ptyLine("  完了時は 14 枚一覧の YAML を reply_to_master で送ります。");
  assert.equal(extractFinalReport(chat), null);
});

test("誤検知しない: マーカー行はあるが job_id が無い（第 2 の錠前）", () => {
  const broken = ptyLine("  imagegen_result: v1") + ptyLine("  summary: \"途中で切れた断片\"");
  assert.equal(extractFinalReport(broken), null);
});

test("同じマーカーが 2 回描かれていたら後ろのブロックを採る", () => {
  const first = ptyLine("  imagegen_result: v1") + ptyLine("  job_id: old-job");
  const second = ptyLine("  imagegen_result: v1") + ptyLine("  job_id: new-job");
  const report = extractFinalReport(first + ptyLine("─────") + second);
  assert.ok(report!.body.includes("job_id: new-job"));
  assert.ok(!report!.body.includes("old-job"));
});

test("転送本文は「サーバが拾った」と分かる形で、報告本文をそのまま含む", () => {
  const report = extractFinalReport(REAL_SCROLLBACK)!;
  const text = buildFinalReportRelayText("vc-weapon-imagegen", report);
  assert.ok(text.includes("[自動転送]"));
  assert.ok(text.includes("vc-weapon-imagegen"));
  assert.ok(text.includes("reply_to_master を呼ばずに"));
  assert.ok(text.includes("read_scrollback"));
  assert.ok(text.endsWith(report.body));
});

test("on/off 判定は EBI_IDLE_NOTIFY と同じ語彙", () => {
  assert.equal(isRelayEnabled(undefined), true);
  assert.equal(isRelayEnabled("on"), true);
  assert.equal(isRelayEnabled("1"), true);
  for (const v of ["off", "OFF", "0", "false", "False"]) {
    assert.equal(isRelayEnabled(v), false, `${v} は無効のはず`);
  }
});

test("正規表現は状態を持たない（g フラグを付けない）", () => {
  // `g` 付きだと lastIndex が残り、同じ入力の 2 回目に false を返す。
  for (let i = 0; i < 3; i++) {
    assert.notEqual(extractFinalReport(REAL_SCROLLBACK), null);
  }
});
