// 固定エビ supervisor のバックエンド差し替え（claude → gemini）の回帰ガード。
//
// 固定するのは 3 点:
//   1. config: fixedEbi[].backend で backend / command / 起動引数の方言が揃うこと
//      （既定＝backend 未指定は従来どおり claude・挙動不変）
//   2. config: appendSystemPrompt が launch.systemPrompt にも載ること
//      （gemini は `--append-system-prompt` 相当を持たず、per-エビ GEMINI.md 経由で
//        役割プロンプトを注入する。args だけだと監督役割が丸ごと落ちる）
//   3. supervisor.ts: ワンショット要約エンジンが supervisor 固定エビの backend / model を
//      引き継ぎ、gemini では `-m <model> --approval-mode yolo -p <prompt>` ＋ GEMINI.md で
//      役割プロンプトを渡すこと（EBI_SUMMARY_CMD スタブは常に最優先）
//
// 実行: node --import tsx --test test/supervisorBackend.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { loadFixedEbi, supervisorEngineFrom } from "../src/server/config.ts";
import {
  Supervisor,
  buildSummaryArgs,
  resolveSummaryEngine,
} from "../src/server/supervisor.ts";
import { GEMINI_SETTINGS_ENV } from "../src/server/backends/index.ts";

/** ebi-team.config.json を一時ディレクトリに書いて loadFixedEbi にかける。 */
async function loadConfig(fixedEbi: unknown[]): Promise<{
  specs: Awaited<ReturnType<typeof loadFixedEbi>>;
  dir: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "ebi-sup-backend-"));
  const path = join(dir, "ebi-team.config.json");
  writeFileSync(path, JSON.stringify({ fixedEbi }, null, 2));
  const specs = await loadFixedEbi(path, { command: "claude" });
  return { specs, dir };
}

const SUPERVISOR_PROMPT =
  "あなたはエビチームの監督エビ。渡されたターミナルログを日本語3〜5行で要約する。";

// ===== 1. config: backend 指定 =====

test("固定エビ: backend 未指定は従来どおり claude（挙動不変）", async () => {
  const { specs, dir } = await loadConfig([
    {
      id: "supervisor",
      kind: "supervisor",
      cwd: ".",
      model: "haiku",
      permissionMode: "auto",
      args: ["--strict-mcp-config"],
      appendSystemPrompt: SUPERVISOR_PROMPT,
    },
  ]);
  try {
    const [s] = specs;
    assert.equal(s.launch.command, "claude");
    assert.equal(s.launch.backend, "claude");
    assert.deepEqual(s.launch.args, [
      "--model",
      "haiku",
      "--permission-mode",
      "auto",
      "--append-system-prompt",
      SUPERVISOR_PROMPT,
      "--strict-mcp-config",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('固定エビ: backend:"gemini" で command / backend / 引数方言がまとめて gemini になる', async () => {
  const { specs, dir } = await loadConfig([
    {
      id: "supervisor",
      kind: "supervisor",
      cwd: ".",
      backend: "gemini",
      model: "gemini-3.5-flash",
      appendSystemPrompt: SUPERVISOR_PROMPT,
    },
  ]);
  try {
    const [s] = specs;
    // command を書かなくても gemini バイナリになる（書き忘れて claude が起動する事故を防ぐ）。
    assert.equal(s.launch.command, "gemini");
    assert.equal(s.launch.backend, "gemini");
    // permissionMode 未指定＝既定 auto → yolo（承認ダイアログで止まらない）。
    assert.deepEqual(s.launch.args, [
      "-m",
      "gemini-3.5-flash",
      "--approval-mode",
      "yolo",
    ]);
    // 役割プロンプトは args に載らない代わりに launch.systemPrompt へ載る（GEMINI.md 用）。
    assert.equal(s.launch.systemPrompt, SUPERVISOR_PROMPT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("固定エビ: permissionMode acceptEdits は auto_edit になる（無人では非推奨）", async () => {
  const { specs, dir } = await loadConfig([
    {
      id: "supervisor",
      kind: "supervisor",
      cwd: ".",
      backend: "gemini",
      permissionMode: "acceptEdits",
    },
  ]);
  try {
    assert.ok(specs[0].launch.args.includes("auto_edit"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("固定エビ: 未知の backend は throw する（黙って claude に落とさない）", async () => {
  await assert.rejects(
    () => loadConfig([{ id: "supervisor", kind: "supervisor", cwd: ".", backend: "ollama" }]),
    /backend が不正です: ollama/,
  );
});

test("固定エビ: appendSystemPrompt は claude でも launch.systemPrompt に載る（buildEnv は無視する）", async () => {
  const { specs, dir } = await loadConfig([
    { id: "master", kind: "master", cwd: ".", appendSystemPrompt: "PM です" },
  ]);
  try {
    assert.equal(specs[0].launch.systemPrompt, "PM です");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===== 2. supervisorEngineFrom =====

test("supervisorEngineFrom: supervisor 固定エビの backend/model を返す", async () => {
  const { specs, dir } = await loadConfig([
    { id: "master", kind: "master", cwd: "." },
    {
      id: "supervisor",
      kind: "supervisor",
      cwd: ".",
      backend: "gemini",
      model: "gemini-3.5-flash",
    },
  ]);
  try {
    assert.deepEqual(supervisorEngineFrom(specs), {
      backend: "gemini",
      model: "gemini-3.5-flash",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supervisorEngineFrom: supervisor 固定エビが無ければ null（既定 claude/haiku のまま）", async () => {
  const { specs, dir } = await loadConfig([{ id: "master", kind: "master", cwd: "." }]);
  try {
    assert.equal(supervisorEngineFrom(specs), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===== 3. 要約エンジンの起動形 =====

test("resolveSummaryEngine: 既定は claude --print --model haiku（従来と同一）", () => {
  const engine = resolveSummaryEngine();
  assert.equal(engine.cmd, "claude");
  assert.equal(engine.backend, "claude");
  assert.equal(engine.model, "haiku");
  assert.deepEqual(engine.baseArgs, ["--print", "--model", "haiku", "--strict-mcp-config"]);
  assert.equal(engine.promptFlag, null);
  assert.equal(engine.systemPromptArgs[0], "--append-system-prompt");
  assert.deepEqual(engine.env, {});

  // プロンプトは常に最後・system prompt はその前。
  const args = buildSummaryArgs(engine, "PROMPT");
  assert.equal(args.at(-1), "PROMPT");
  assert.equal(args.at(-3), "--append-system-prompt");
});

test("resolveSummaryEngine: gemini は -m/--approval-mode yolo/-p の順で組み立てる", () => {
  const base = mkdtempSync(join(tmpdir(), "ebi-sup-gemini-"));
  try {
    const engine = resolveSummaryEngine({
      backend: "gemini",
      model: "gemini-3.5-flash",
      geminiRuntimeBaseDir: base,
    });
    assert.equal(engine.cmd, "gemini");
    assert.equal(engine.backend, "gemini");
    assert.equal(engine.model, "gemini-3.5-flash");
    assert.deepEqual(engine.baseArgs, [
      "-m",
      "gemini-3.5-flash",
      "--approval-mode",
      "yolo",
    ]);
    // gemini には --append-system-prompt 相当が無いので引数では渡さない。
    assert.deepEqual(engine.systemPromptArgs, []);
    assert.deepEqual(buildSummaryArgs(engine, "PROMPT"), [
      "-m",
      "gemini-3.5-flash",
      "--approval-mode",
      "yolo",
      "-p",
      "PROMPT",
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveSummaryEngine: gemini は役割プロンプトを per-エビ GEMINI.md で渡す", () => {
  const base = mkdtempSync(join(tmpdir(), "ebi-sup-gemini-"));
  try {
    const engine = resolveSummaryEngine({ backend: "gemini", geminiRuntimeBaseDir: base });
    const settingsPath = engine.env[GEMINI_SETTINGS_ENV];
    assert.ok(settingsPath, "system settings のパスが env で渡ること");

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    // 起動ゲート（folderTrust）と自動更新は無効化されていること。
    assert.equal(settings.security.folderTrust.enabled, false);
    assert.equal(settings.general.enableAutoUpdate, false);
    // 要約エンジンに制御MCP は要らない（ワンショットで stdout を読むだけ）。
    assert.deepEqual(settings.mcpServers, {});
    // 役割プロンプトの置き場が context として読み込まれること。
    assert.equal(settings.context.loadMemoryFromIncludeDirectories, true);
    const ctxDir = settings.context.includeDirectories[0];
    const md = readFileSync(join(ctxDir, "GEMINI.md"), "utf8");
    assert.match(md, /監督アシスタント/);
    assert.match(md, /3〜5行/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveSummaryEngine: gemini 系でない model は Flash 系最新へ落とす（alias 404 対策）", () => {
  const base = mkdtempSync(join(tmpdir(), "ebi-sup-gemini-"));
  try {
    // claude 用の "haiku" がそのまま -m に流れると 404 になるため落とす。
    const engine = resolveSummaryEngine({
      backend: "gemini",
      model: "haiku",
      geminiRuntimeBaseDir: base,
    });
    assert.equal(engine.model, "gemini-3.5-flash");
    // gemini 系の明示 ID はそのまま尊重する。
    const pro = resolveSummaryEngine({
      backend: "gemini",
      model: "gemini-2.5-pro",
      geminiRuntimeBaseDir: base,
    });
    assert.equal(pro.model, "gemini-2.5-pro");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveSummaryEngine: EBI_SUMMARY_CMD スタブは backend 指定より優先される", () => {
  const prev = process.env.EBI_SUMMARY_CMD;
  process.env.EBI_SUMMARY_CMD = "/bin/echo stub";
  try {
    const engine = resolveSummaryEngine({ backend: "gemini" });
    assert.equal(engine.isStub, true);
    assert.equal(engine.cmd, "/bin/echo");
    assert.deepEqual(engine.baseArgs, ["stub"]);
    // スタブに CLI 固有フラグを渡さない（解釈できず即終了するため）。
    assert.deepEqual(engine.systemPromptArgs, []);
    assert.equal(engine.promptFlag, null);
    assert.deepEqual(engine.env, {});
  } finally {
    if (prev === undefined) delete process.env.EBI_SUMMARY_CMD;
    else process.env.EBI_SUMMARY_CMD = prev;
  }
});

test("Supervisor: codex 指定は claude へフォールバックし起動ログで明示する", () => {
  const prev = process.env.EBI_SUMMARY_CMD;
  delete process.env.EBI_SUMMARY_CMD;
  try {
    const sup = new Supervisor({ backend: "codex" });
    const line = sup.describeStartup();
    assert.match(line, /codex/);
    assert.match(line, /claude で代替/);
  } finally {
    if (prev !== undefined) process.env.EBI_SUMMARY_CMD = prev;
  }
});

test("Supervisor: 出力が短すぎる場合は要約せず理由を返す（従来どおり）", async () => {
  const prev = process.env.EBI_SUMMARY_CMD;
  process.env.EBI_SUMMARY_CMD = "/bin/echo";
  try {
    const sup = new Supervisor({ backend: "gemini" });
    const r = await sup.summarize("短い");
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /要約をスキップ/);
  } finally {
    if (prev === undefined) delete process.env.EBI_SUMMARY_CMD;
    else process.env.EBI_SUMMARY_CMD = prev;
  }
});
