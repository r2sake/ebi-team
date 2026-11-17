// 推論努力度（claude の `--effort`）の解決の回帰テスト。
//
// 背景: effort は master 固定エビの args 直書きでしか渡せず、役割付きの動的エビや
// model 上書き経由の spawn には一切届いていなかった（= CLI 既定 medium）。
// 「モデル→effort の既定表」（config の top-level effortByModel）を 1 か所置き、
// 全 spawn 経路が同じ表を見るようにした。
//
// 固定するのは 4 点:
//   1. effortByModel の検証・正規化（不正値は黙って無視せず throw）
//   2. モデル引き当ての優先（完全一致 > 具体的なパターン > 記載順）と大文字小文字非依存
//   3. 解決の優先順位（args 明示 > 明示 effort > 役割 effort > モデル表 > CLI 既定）
//   4. 固定エビ config で表が args まで効くこと（二重付与しない・claude 以外には付けない）
//
// 実行: node --import tsx --test test/effort.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

import {
  EFFORT_LEVELS,
  describeEffort,
  effortArgs,
  effortForModel,
  hasEffortArg,
  normalizeEffortByModel,
  resolveEffort,
  validateEffort,
} from "../src/server/effort.ts";
import { loadEffortByModel, loadFixedEbi } from "../src/server/config.ts";
import { EBI_ROLES, registerCustomRoles, resolveRole } from "../src/server/roles.ts";

// ===== 1. 検証・正規化 =====

test("effortByModel: { モデルパターン: effort } を記載順で正規化する", () => {
  const table = normalizeEffortByModel({ "claude-opus-5-5": "high", "claude-haiku-*": "low" });
  assert.deepEqual(table, [
    { pattern: "claude-opus-5-5", effort: "high" },
    { pattern: "claude-haiku-*", effort: "low" },
  ]);
});

test("effortByModel: 未指定は空の表（CLI 既定に任せる）", () => {
  assert.deepEqual(normalizeEffortByModel(undefined), []);
  assert.deepEqual(normalizeEffortByModel(null), []);
});

test("effortByModel: 値域外・型不正・配列は throw（黙って無視しない）", () => {
  assert.throws(() => normalizeEffortByModel({ "claude-opus-5-5": "ultra" }), /effort が不正です/);
  assert.throws(() => normalizeEffortByModel({ "claude-opus-5-5": 3 }), /文字列/);
  assert.throws(() => normalizeEffortByModel([{ pattern: "x" }]), /オブジェクト/);
  assert.throws(() => normalizeEffortByModel({ "": "high" }), /キー/);
});

test("validateEffort: 値域は low/medium/high のみ", () => {
  assert.deepEqual([...EFFORT_LEVELS], ["low", "medium", "high"]);
  for (const v of EFFORT_LEVELS) assert.equal(validateEffort(v), v);
  assert.throws(() => validateEffort("HIGH"), /effort が不正です/);
});

// ===== 2. モデル引き当て =====

test("effortForModel: 完全一致が最優先、次にパターンが具体的なもの", () => {
  const table = normalizeEffortByModel({
    "claude-*": "low",
    "claude-opus-*": "medium",
    "claude-opus-5-5": "high",
  });
  assert.equal(effortForModel("claude-opus-5-5", table), "high");
  assert.equal(effortForModel("claude-opus-5", table), "medium");
  assert.equal(effortForModel("claude-sonnet-5", table), "low");
  assert.equal(effortForModel("gpt-5.5", table), null);
  assert.equal(effortForModel(null, table), null);
});

test("effortForModel: 大文字小文字は区別しない", () => {
  const table = normalizeEffortByModel({ "claude-opus-5-5": "high" });
  assert.equal(effortForModel("Claude-Opus-5-5", table), "high");
});

test("hasEffortArg: --effort / --effort=high の両形を検出する", () => {
  assert.equal(hasEffortArg(["--model", "opus"]), false);
  assert.equal(hasEffortArg(["--effort", "medium"]), true);
  assert.equal(hasEffortArg(["--effort=low"]), true);
});

// ===== 3. 優先順位 =====

test("resolveEffort: args 明示 > 明示 effort > 役割 effort > モデル表 > CLI 既定", () => {
  const table = normalizeEffortByModel({ "claude-opus-5-5": "high" });

  // args に既に --effort があれば一切足さない（運用者が書いた値を尊重＝二重付与しない）。
  assert.deepEqual(
    resolveEffort({ explicit: "low", role: "medium", model: "claude-opus-5-5", table, existingArgs: ["--effort", "medium"] }),
    { effort: null, source: "args" },
  );
  // 明示 effort が役割・表より強い。
  assert.deepEqual(resolveEffort({ explicit: "low", role: "medium", model: "claude-opus-5-5", table }), {
    effort: "low",
    source: "explicit",
  });
  // 役割 effort が表より強い。
  assert.deepEqual(resolveEffort({ role: "medium", model: "claude-opus-5-5", table }), {
    effort: "medium",
    source: "role",
  });
  // 表が効く（今回の主目的: Opus 5.5 は high）。
  assert.deepEqual(resolveEffort({ model: "claude-opus-5-5", table }), {
    effort: "high",
    source: "model",
  });
  // どれにも当たらなければ付与しない（CLI 既定）。
  assert.deepEqual(resolveEffort({ model: "fable", table }), { effort: null, source: null });
  assert.deepEqual(resolveEffort({}), { effort: null, source: null });
});

test("resolveEffort: 明示 effort の値域外は throw（黙って捨てない）", () => {
  assert.throws(() => resolveEffort({ explicit: "max" }), /effort が不正です/);
});

test("effortArgs / describeEffort: 付与する引数と起動ログ文言", () => {
  const byModel = resolveEffort({ model: "claude-opus-5-5", table: normalizeEffortByModel({ "claude-opus-5-5": "high" }) });
  assert.deepEqual(effortArgs(byModel), ["--effort", "high"]);
  assert.equal(describeEffort(byModel), "effort: high (by model)");
  assert.equal(describeEffort({ effort: "low", source: "role" }), "effort: low (by role)");
  assert.equal(describeEffort({ effort: "high", source: "explicit" }), "effort: high (explicit)");
  assert.equal(describeEffort({ effort: null, source: "args" }), null);
  assert.deepEqual(effortArgs({ effort: null, source: null }), []);
});

// ===== 4. 役割定義（config の roles[].effort） =====

test("カスタム役割: effort を持てる／値域外は起動時エラー", () => {
  const before = { ...EBI_ROLES };
  try {
    registerCustomRoles({ "deep-thinker": { defaultModel: "claude-opus-5-5", effort: "high" } });
    assert.equal(resolveRole("deep-thinker")?.effort, "high");
    // 未指定の役割は effort を持たない（表 → CLI 既定へフォールバックする）。
    assert.equal(resolveRole("engineer")?.effort, undefined);
    assert.throws(
      () => registerCustomRoles({ bad: { effort: "ultra" } }),
      /カスタム役割 "bad" の effort が不正です/,
    );
  } finally {
    for (const key of Object.keys(EBI_ROLES)) delete EBI_ROLES[key];
    Object.assign(EBI_ROLES, before);
  }
});

// ===== 5. 固定エビ config 経由（args まで効くか） =====

/** ebi-team.config.json を一時ディレクトリに書いて loadFixedEbi / loadEffortByModel にかける。 */
async function loadConfig(raw: Record<string, unknown>): Promise<{
  specs: Awaited<ReturnType<typeof loadFixedEbi>>;
  path: string;
  dir: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "ebi-effort-"));
  const path = join(dir, "ebi-team.config.json");
  writeFileSync(path, JSON.stringify(raw, null, 2));
  const specs = await loadFixedEbi(path, { command: "claude" });
  return { specs, path, dir };
}

test("固定エビ: effortByModel が model に当たれば --effort が付く", async () => {
  const { specs, path, dir } = await loadConfig({
    effortByModel: { "claude-opus-5-5": "high" },
    fixedEbi: [{ id: "minaebi", kind: "dynamic", cwd: ".", model: "claude-opus-5-5" }],
  });
  try {
    const [s] = specs;
    assert.equal(s.effort, "high");
    assert.deepEqual(s.extraArgs, ["--effort", "high"]);
    assert.deepEqual(s.launch.args, ["--model", "claude-opus-5-5", "--permission-mode", "auto", "--effort", "high"]);
    assert.deepEqual(await loadEffortByModel(path), [{ pattern: "claude-opus-5-5", effort: "high" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("固定エビ: args の --effort 明示が最優先（二重付与しない）", async () => {
  const { specs, dir } = await loadConfig({
    effortByModel: { "*": "high" },
    fixedEbi: [
      { id: "master", kind: "master", cwd: ".", model: "fable", args: ["--effort", "medium"] },
    ],
  });
  try {
    const [s] = specs;
    assert.equal(s.effort, null);
    assert.deepEqual(s.extraArgs, ["--effort", "medium"]);
    assert.equal(s.launch.args.filter((a) => a === "--effort").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("固定エビ: 表に当たらない model / claude 以外の起動には付けない", async () => {
  const { specs, dir } = await loadConfig({
    effortByModel: { "claude-opus-5-5": "high" },
    fixedEbi: [
      // 表に当たらない model。
      { id: "supervisor", kind: "supervisor", cwd: ".", model: "haiku" },
      // codex backend（`--effort` は claude 方言なので付けない）。
      { id: "imagegen", kind: "dynamic", cwd: ".", backend: "codex", model: "claude-opus-5-5" },
      // どの backend にも一致しない command（スタブ起動）。
      { id: "stub", kind: "dynamic", cwd: ".", command: "bash", model: "claude-opus-5-5" },
    ],
  });
  try {
    for (const s of specs) {
      assert.equal(s.effort, null, `${s.id} に effort が付いている`);
      assert.equal(hasEffortArg(s.launch.args), false, `${s.id} の args に --effort が付いている`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("固定エビ: effortByModel の値が不正なら config 読み込みで throw（起動時に気づける）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ebi-effort-bad-"));
  const path = join(dir, "ebi-team.config.json");
  writeFileSync(path, JSON.stringify({ effortByModel: { "claude-opus-5-5": "ultra" }, fixedEbi: [] }));
  try {
    await assert.rejects(() => loadEffortByModel(path), /effort が不正です/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
