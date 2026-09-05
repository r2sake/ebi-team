// imagegen の依頼(imagegen_job)/報告(imagegen_result) 様式と、生成後の正規化コマンドの純関数テスト。
//
// 対象:
//   1. 依頼 YAML の検証（必須・上限 6 枚・id 重複・size/fit/format・dest_root の閉じ込め）
//   2. ボス裁定 A1「id 指定で作り直し」= regenerate の絞り込み
//   3. 生成後コマンドが「リサイズと形式変換だけ」で、減色・トリム・歪むリサイズを含まないこと
//   4. 報告 YAML の検証（status/error_code の語彙・path 絶対・pixels 実測）
//   5. 様式で使う語（error_code・再ログイン案内）が codex の ACK 誤検知パターンに当たらないこと
//
// 設計: docs/design/imagegen-role-2026-09-05.md

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CODEX_RELOGIN_HINT,
  IMAGEGEN_ERROR_CODES,
  ImagegenValidationError,
  MAX_IMAGES_PER_JOB,
  buildPostProcessCommands,
  defaultDestRoot,
  outputFileNames,
  parseImagegenJob,
  parseImagegenResult,
  targetImages,
} from "../src/server/imagegen.ts";
import { CODEX_ACK_FAILURE_PATTERNS, CODEX_BACKEND, matchAckFailure } from "../src/server/backends/index.ts";

const VALID_JOB = `imagegen_job: v1
job_id: vc-standee-2026-09-05
requester: ebi-3
images:
  - id: hero-icon
    purpose: トップの見出し横に置くアイコン
    prompt: |
      白背景に、エビのマスコットのフラットアイコン。
      文字は入れない。
    size: 512x512
    format: png
  - id: empty-state
    purpose: 一覧が空のときのイラスト
    prompt: |
      白背景に、空の皿の前で首をかしげるエビのマスコット。
    count: 2
    size: 1024x1024
notes: |
  すべて同一トーンで揃えること。
`;

/** 検証エラーの本文を取り出す（assert.throws のメッセージ照合用）。 */
function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ImagegenValidationError, `想定外の例外: ${String(err)}`);
    return [...err.issues];
  }
  assert.fail("エラーになりませんでした");
}

test("依頼: 正常な YAML を正規化できる（既定値・複数行 prompt・count 連番）", () => {
  const job = parseImagegenJob(VALID_JOB);
  assert.equal(job.jobId, "vc-standee-2026-09-05");
  assert.equal(job.requester, "ebi-3");
  // dest_root 省略時は tmp/images/<job_id>（ボス裁定 A1: 採否前は ebi-team 側に置く）。
  assert.equal(job.destRoot, defaultDestRoot("vc-standee-2026-09-05"));
  assert.equal(job.images.length, 2);
  const [hero, empty] = job.images;
  assert.equal(hero!.count, 1);
  assert.equal(hero!.fit, "contain");
  assert.equal(hero!.format, "png");
  assert.match(hero!.prompt, /文字は入れない/);
  assert.match(hero!.prompt, /^白背景に、エビのマスコットのフラットアイコン。\n/);
  assert.deepEqual(hero!.size, { width: 512, height: 512 });
  assert.equal(empty!.count, 2);
  assert.deepEqual(outputFileNames(hero!), ["hero-icon.png"]);
  assert.deepEqual(outputFileNames(empty!), ["empty-state-1.png", "empty-state-2.png"]);
  assert.match(job.notes ?? "", /同一トーン/);
});

test("依頼: 1 ジョブの上限は 6 枚（count の合計で判定・ボス裁定 A2）", () => {
  const over = `imagegen_job: v1
job_id: too-many
images:
  - id: a
    purpose: p
    prompt: x
    count: 4
  - id: b
    purpose: p
    prompt: x
    count: 3
`;
  const issues = issuesOf(() => parseImagegenJob(over));
  assert.ok(
    issues.some((i) => i.includes(`上限は ${MAX_IMAGES_PER_JOB} 枚`) && i.includes("= 7")),
    issues.join(" / "),
  );
});

test("依頼: 必須欠落・id 重複・size/fit/format の誤りをまとめて指摘する", () => {
  const bad = `imagegen_job: v1
job_id: bad_id!
images:
  - id: a
    purpose: p
    prompt: x
    size: 512
    fit: cover
    format: jpg
  - id: a
    prompt: x
    purpose: p
`;
  const issues = issuesOf(() => parseImagegenJob(bad));
  const joined = issues.join("\n");
  assert.match(joined, /job_id は英数と - のみ/);
  assert.match(joined, /size は WxH/);
  // 切り抜き（cover）は VC 方針で禁止＝様式として受け付けない。
  assert.match(joined, /fit は contain か none のみ/);
  assert.match(joined, /format は png か webp のみ/);
  assert.match(joined, /id が重複/);
});

test("依頼: バージョン不一致・images 無しは即エラー", () => {
  assert.match(issuesOf(() => parseImagegenJob("imagegen_job: v2\njob_id: a\n")).join(), /v1 のみ対応/);
  assert.match(issuesOf(() => parseImagegenJob("job_id: a\n")).join(), /先頭に imagegen_job: v1/);
  assert.match(
    issuesOf(() => parseImagegenJob("imagegen_job: v1\njob_id: a\n")).join(),
    /images はリスト/,
  );
});

test("依頼: dest_root は cwd 配下の相対パスだけ（絶対パス・.. を弾く）", () => {
  const mk = (dest: string) =>
    `imagegen_job: v1\njob_id: a\ndest_root: ${dest}\nimages:\n  - id: a\n    purpose: p\n    prompt: x\n`;
  assert.match(issuesOf(() => parseImagegenJob(mk("/tmp/out"))).join(), /相対パスにすること/);
  assert.match(issuesOf(() => parseImagegenJob(mk("../other/assets"))).join(), /相対パスにすること/);
  assert.equal(parseImagegenJob(mk("tmp/images/a")).destRoot, "tmp/images/a");
});

test("依頼: regenerate で id を絞って作り直せる（ボス裁定 A1・同じ依頼を再投入する）", () => {
  const job = parseImagegenJob(VALID_JOB + "regenerate: [empty-state]\n");
  assert.deepEqual([...(job.regenerate ?? [])], ["empty-state"]);
  assert.deepEqual(targetImages(job).map((s) => s.id), ["empty-state"]);
  // regenerate 無しなら全件。
  assert.equal(targetImages(parseImagegenJob(VALID_JOB)).length, 2);
  // 存在しない id は指摘する（黙って 0 枚生成しない）。
  assert.match(
    issuesOf(() => parseImagegenJob(VALID_JOB + "regenerate: [typo]\n")).join(),
    /images に存在しません/,
  );
});

test("正規化コマンド: 許すのはリサイズ（-Z）と PNG→WebP だけ（減色・トリム・歪みを生成しない）", () => {
  const job = parseImagegenJob(VALID_JOB);
  const cmds = buildPostProcessCommands(
    "/Users/me/.codex/generated_images/uuid/exec-uuid.png",
    job.destRoot,
    job.images[0]!,
    "hero-icon.png",
  ).join("\n");
  assert.match(cmds, /^mkdir -p /);
  assert.match(cmds, /sips -Z 512 /);
  assert.match(cmds, /sips -g pixelWidth -g pixelHeight /);
  assert.match(cmds, /stat -f%z /);
  // 歪む縦横強制・切り抜き・減色・背景除去は 1 つも出さない。
  assert.doesNotMatch(cmds, /sips -z /);
  assert.doesNotMatch(cmds, /-c |--crop|-crop|posterize|--colors|pngquant|magick|convert /);
  assert.doesNotMatch(cmds, /cwebp/); // format: png では変換しない
});

test("正規化コマンド: format: webp は cwebp -q 90 を通し、size 無し/fit none ではリサイズしない", () => {
  const job = parseImagegenJob(
    `imagegen_job: v1\njob_id: w\nimages:\n  - id: a\n    purpose: p\n    prompt: x\n    size: none\n    format: webp\n`,
  );
  const cmds = buildPostProcessCommands("/gen/exec.png", "tmp/images/w", job.images[0]!, "a.webp").join("\n");
  assert.match(cmds, /cwebp -q 90 'tmp\/images\/w\/a\.png' -o 'tmp\/images\/w\/a\.webp'/);
  assert.doesNotMatch(cmds, /sips -Z/);
});

test("報告: 正常な YAML を正規化できる", () => {
  const res = parseImagegenResult(`imagegen_result: v1
job_id: vc-standee-2026-09-05
summary: 1/2 ok, 1 failed
results:
  - id: hero-icon
    status: ok
    path: /Users/me/workspace/GitHub/ebi-team/tmp/images/x/hero-icon.png
    pixels: 1254x1254
    bytes: 831865
    format: png
    tool: image_gen__imagegen
  - id: empty-state
    status: failed
    error_code: GEN_ERROR
    note: ツールがエラー応答。1 回だけ再試行して同じ結果。
gen_seconds: 233
`);
  assert.equal(res.results.length, 2);
  assert.equal(res.results[0]!.pixels, "1254x1254");
  assert.equal(res.results[0]!.bytes, 831865);
  assert.equal(res.results[1]!.errorCode, "GEN_ERROR");
  assert.equal(res.genSeconds, 233);
});

test("報告: status ok は絶対パスと実測 pixels が必須／未知の status・error_code は弾く", () => {
  const issues = issuesOf(() =>
    parseImagegenResult(`imagegen_result: v1
job_id: a
summary: s
results:
  - id: a
    status: ok
    path: tmp/images/a/a.png
  - id: b
    status: broken
  - id: c
    status: failed
    error_code: TOOL_UNAVAILABLE
`),
  );
  const joined = issues.join("\n");
  assert.match(joined, /path は絶対パスで書くこと/);
  assert.match(joined, /pixels は実測値/);
  assert.match(joined, /status は ok \| failed \| refused \| skipped/);
  assert.match(joined, /error_code は GEN_TOOL_OFF/);
});

test("報告: ok 以外は error_code が必須（原因不明の失敗を黙って返させない）", () => {
  assert.match(
    issuesOf(() =>
      parseImagegenResult(
        "imagegen_result: v1\njob_id: a\nsummary: s\nresults:\n  - id: a\n    status: failed\n",
      ),
    ).join(),
    /error_code が必要/,
  );
});

test("様式の語彙は codex の ACK 誤検知パターンに当たらない（error_code・再ログイン案内）", () => {
  // 設計 §6.4 の実害: error_code を TOOL_UNAVAILABLE にしていた初版は英語パターンに一致した。
  for (const code of IMAGEGEN_ERROR_CODES) {
    assert.equal(
      matchAckFailure(`error_code: ${code}`, CODEX_ACK_FAILURE_PATTERNS),
      null,
      `error_code が ACK 検知語に一致します: ${code}`,
    );
  }
  // ボス裁定 A5: 認証/プラン起因のときに報告へ入れる一文（profiles.ts の検知語と衝突しないこと）。
  assert.equal(matchAckFailure(CODEX_RELOGIN_HINT, CODEX_ACK_FAILURE_PATTERNS), null);
  // codex の fatalPatterns にも当たらないこと。初版は「`codex login` のやり直し」と書いており、
  // 役割プロンプトのエコーが /(codex login|...)/i に一致して偽の「起動エラー」通知を立てた。
  assert.equal(
    matchAckFailure(CODEX_RELOGIN_HINT, CODEX_BACKEND.fatalPatterns ?? []),
    null,
    "再ログイン案内が codex の fatalPatterns に一致します（偽の起動エラー通知の元）",
  );
  // それでも「ログインをやり直す」意図は読み取れること（master がボスに渡す一文）。
  assert.match(CODEX_RELOGIN_HINT, /login/);
  assert.match(CODEX_RELOGIN_HINT, /再ログイン/);
});
