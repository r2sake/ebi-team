// Gemini バックエンド（PR-C）の単体テスト。
//
// 固定する対象:
//   1. buildArgs（PoC で 20/20 成立した起動形・permissionMode 写像・モデル解決）
//   2. per-エビ system settings の生成（folderTrust/autoUpdate/alt-screen/trust:true/context）
//   3. buildEnv の実 I/O（runtime ディレクトリへの書き出しと GEMINI_CLI_SYSTEM_SETTINGS_PATH）
//   4. preflight（認証ファイル欠如は error・GOOGLE_CLOUD_PROJECT は任意・版差は warning）
//   5. kill のプロセスグループ分岐（負の pid へ送っているか）
//   6. claude の外形ゼロ差分（gemini 追加で claude 側が変わっていないこと）

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BACKEND_TRAITS,
  CLAUDE_BACKEND,
  GEMINI_BACKEND,
  GEMINI_DEFAULT_MODEL,
  GEMINI_SETTINGS_ENV,
  GEMINI_VERIFIED_VERSION,
  buildGeminiSettings,
  controlMcpSpecFromClaudeConfig,
  evaluatePreflight,
  geminiRuntimeDir,
  getBackend,
  resolveBackend,
  resolveGeminiModel,
  toGeminiApprovalMode,
  writeGeminiRuntime,
  type ControlMcpSpec,
} from "../src/server/backends/index.ts";
import { buildSpawnEnv, killProcessGroupSignal } from "../src/server/agent.ts";
import { needsPreflight } from "../src/server/backendPreflight.ts";

/** claude 方言の MCP config（gen-master-mcp.mjs の生成物と同形）。 */
const CLAUDE_MCP_JSON = JSON.stringify(
  {
    mcpServers: {
      "ebi-control": {
        command: "node",
        args: ["/repo/dist/server/mcp/control-server.js"],
        cwd: "/repo",
        env: { EBI_CONTROL_URL: "http://127.0.0.1:8787", EBI_MCP_ROLE: "engineer" },
      },
    },
  },
  null,
  2,
);

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ebi-gemini-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ===== 1. buildArgs =====

test("buildArgs: PoC で成立した起動形（-m / --approval-mode / --allowed-mcp-server-names）", () => {
  const args = GEMINI_BACKEND.buildArgs({
    model: null,
    permissionMode: "bypassPermissions",
    systemPrompt: "役割プロンプト",
    mcpConfigPath: "/repo/.ebi-team/engineer-control.mcp.json",
    notifyMode: true,
    extraArgs: [],
  });
  assert.deepEqual(args, [
    "-m",
    "gemini-2.5-flash",
    "--approval-mode",
    "yolo",
    "--allowed-mcp-server-names",
    "ebi-control",
  ]);
  // 役割プロンプトは引数に出さない（gemini に --append-system-prompt 相当が無いため）。
  assert.equal(args.includes("役割プロンプト"), false);
});

test("buildArgs: 制御MCP なしなら --allowed-mcp-server-names を付けない・extraArgs は末尾", () => {
  const args = GEMINI_BACKEND.buildArgs({
    model: "gemini-2.5-pro",
    permissionMode: null,
    systemPrompt: null,
    mcpConfigPath: null,
    notifyMode: false,
    extraArgs: ["--debug"],
  });
  assert.deepEqual(args, ["-m", "gemini-2.5-pro", "--approval-mode", "yolo", "--debug"]);
});

test("permissionMode 写像: 無人運用の既定は yolo・acceptEdits は auto_edit・plan は default", () => {
  assert.equal(toGeminiApprovalMode("bypassPermissions"), "yolo");
  assert.equal(toGeminiApprovalMode("dontAsk"), "yolo");
  assert.equal(toGeminiApprovalMode("auto"), "yolo");
  assert.equal(toGeminiApprovalMode(null), "yolo");
  assert.equal(toGeminiApprovalMode("acceptEdits"), "auto_edit");
  assert.equal(toGeminiApprovalMode("default"), "default");
  assert.equal(toGeminiApprovalMode("plan"), "default");
});

test("モデル解決: gemini 系でない指定（役割既定の claude-opus-5）は既定モデルへ落とす", () => {
  assert.equal(resolveGeminiModel(null), GEMINI_DEFAULT_MODEL);
  assert.equal(resolveGeminiModel("claude-opus-5"), GEMINI_DEFAULT_MODEL);
  assert.equal(resolveGeminiModel("opus"), GEMINI_DEFAULT_MODEL);
  assert.equal(resolveGeminiModel("gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(resolveGeminiModel("gemini-2.5-flash"), "gemini-2.5-flash");
});

test("レジストリ: gemini が実装済みで command からも解決できる", () => {
  assert.equal(getBackend("gemini"), GEMINI_BACKEND);
  assert.equal(resolveBackend("gemini")?.id, "gemini");
  assert.equal(resolveBackend("/Users/x/.npm-global/bin/gemini")?.id, "gemini");
  assert.equal(resolveBackend("claude")?.id, "claude");
  assert.equal(resolveBackend("bash"), null);
  assert.equal(GEMINI_BACKEND.defaultCommand, "gemini");
  // 通信路の性質: channel 注入は非対応・購読を待たず PTY 注入へ落とす。
  assert.equal(GEMINI_BACKEND.supportsChannelInject, false);
  assert.equal(GEMINI_BACKEND.hasControlBridge([], {}), false);
  // 起動ゲートは settings で消すので自動応答の対象にしない。
  assert.equal(GEMINI_BACKEND.startupGates, null);
  assert.equal(GEMINI_BACKEND.supportsInitialPrompt, true);
  assert.deepEqual(GEMINI_BACKEND.initialPromptArgs("やって"), ["-i", "やって"]);
});

// ===== 2. system settings の生成 =====

test("MCP config（claude 方言）から中立表現へ戻す: EBI_ID 直焼き・購読 off", () => {
  const spec = controlMcpSpecFromClaudeConfig(CLAUDE_MCP_JSON, { agentId: "ebi-7" });
  assert.equal(spec.name, "ebi-control");
  assert.equal(spec.command, "node");
  assert.deepEqual([...spec.args], ["/repo/dist/server/mcp/control-server.js"]);
  assert.equal(spec.cwd, "/repo");
  assert.deepEqual(spec.env, {
    EBI_CONTROL_URL: "http://127.0.0.1:8787",
    EBI_MCP_ROLE: "engineer",
    EBI_ID: "ebi-7",
    EBI_NOTIFY_SUBSCRIBE: "off",
  });
});

test("壊れた / 空の MCP config は明示エラー（黙って MCP 無しで起動しない）", () => {
  assert.throws(
    () => controlMcpSpecFromClaudeConfig("{ oops", { agentId: "ebi-1" }),
    /JSON を解析できません/,
  );
  assert.throws(
    () => controlMcpSpecFromClaudeConfig("{}", { agentId: "ebi-1" }),
    /mcpServers がありません/,
  );
});

test("settings 生成: PoC 必須項目（folderTrust=false / autoUpdate=false / alt-screen=false / trust=true）", () => {
  const spec = controlMcpSpecFromClaudeConfig(CLAUDE_MCP_JSON, { agentId: "ebi-7" });
  const settings = buildGeminiSettings(spec, { contextDir: "/rt/ebi-7", authType: "oauth-personal" });
  assert.equal(settings.security.folderTrust.enabled, false);
  assert.equal(settings.security.auth?.selectedType, "oauth-personal");
  assert.equal(settings.general.enableAutoUpdate, false);
  assert.equal(settings.general.checkForUpdates, false);
  assert.equal(settings.ui.useAlternateBuffer, false);
  assert.equal(settings.mcpServers["ebi-control"].trust, true);
  assert.equal(settings.mcpServers["ebi-control"].env.EBI_ID, "ebi-7");
  // 役割プロンプトは include ディレクトリ経由（worktree を汚さない）。
  assert.deepEqual(settings.context, {
    includeDirectories: ["/rt/ebi-7"],
    loadMemoryFromIncludeDirectories: true,
  });
});

test("settings 生成: 制御MCP 無しでもゲート無効化のために settings は作る（mcpServers は空）", () => {
  const settings = buildGeminiSettings(null, { contextDir: null });
  assert.deepEqual(settings.mcpServers, {});
  assert.equal(settings.security.folderTrust.enabled, false);
  assert.equal(settings.general.enableAutoUpdate, false);
  assert.equal(settings.context, undefined);
});

// ===== 3. buildEnv（実 I/O） =====

test("buildEnv: runtime へ settings.json と役割 GEMINI.md を書き、パスを env で渡す", () => {
  withTmpDir((dir) => {
    const mcpPath = join(dir, "engineer-control.mcp.json");
    writeFileSync(mcpPath, CLAUDE_MCP_JSON);
    const env = writeGeminiRuntime({
      agentId: "ebi-9",
      mcpConfigPath: mcpPath,
      systemPrompt: "あなたはエビチームの engineer エビ。",
      baseDir: join(dir, "runtime"),
    });
    const settingsPath = env[GEMINI_SETTINGS_ENV];
    assert.equal(settingsPath, join(dir, "runtime", "ebi-9", "settings.json"));
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(written.mcpServers["ebi-control"].env.EBI_ID, "ebi-9");
    assert.equal(written.security.folderTrust.enabled, false);
    const md = readFileSync(join(dir, "runtime", "ebi-9", "GEMINI.md"), "utf8");
    assert.match(md, /engineer エビ/);
    assert.match(md, /# エビチーム: このセッションの役割/);
    // 置き場はエビの作業ディレクトリの外（runtime 配下）であること。
    assert.equal(geminiRuntimeDir("ebi-9", join(dir, "runtime")), join(dir, "runtime", "ebi-9"));
  });
});

test("buildEnv: 役割プロンプトが無ければ GEMINI.md も context も作らない", () => {
  withTmpDir((dir) => {
    const env = writeGeminiRuntime({
      agentId: "ebi-10",
      mcpConfigPath: null,
      systemPrompt: null,
      baseDir: join(dir, "runtime"),
    });
    const settings = JSON.parse(readFileSync(env[GEMINI_SETTINGS_ENV], "utf8"));
    assert.equal(settings.context, undefined);
    assert.throws(() => readFileSync(join(dir, "runtime", "ebi-10", "GEMINI.md"), "utf8"));
  });
});

test("buildSpawnEnv: EBI_INLINE_TUI=off でも gemini の settings パスは落ちない（起動の必須条件）", () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, "runtime"), { recursive: true });
    // agent.ts は inlineTui の判断を backend へ委譲し、buildSpawnEnv には常に true を渡す。
    const backendEnv = writeGeminiRuntime({
      agentId: "ebi-11",
      mcpConfigPath: null,
      systemPrompt: null,
      baseDir: join(dir, "runtime"),
    });
    const env = buildSpawnEnv({ PATH: "/usr/bin" }, { EBI_ID: "ebi-11" }, true, backendEnv, [
      ...GEMINI_BACKEND.envDenyList,
    ]);
    assert.equal(env[GEMINI_SETTINGS_ENV], backendEnv[GEMINI_SETTINGS_ENV]);
    // claude 側は inlineTui:false のとき空を返す（従来の「丸ごと落とす」挙動と同一）。
    assert.deepEqual(CLAUDE_BACKEND.buildEnv({ inlineTui: false }), {});
    assert.deepEqual(CLAUDE_BACKEND.buildEnv(), {
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
      CLAUDE_CODE_DISABLE_MOUSE: "1",
    });
  });
});

test("envDenyList: API キー系は落とすが GOOGLE_CLOUD_PROJECT は継承する（Workspace 枠で必須）", () => {
  const env = buildSpawnEnv(
    {
      PATH: "/usr/bin",
      GOOGLE_CLOUD_PROJECT: "engineering-478708",
      GEMINI_API_KEY: "k",
      GOOGLE_API_KEY: "k",
      GOOGLE_GENAI_USE_VERTEXAI: "1",
      GOOGLE_GENAI_USE_GCA: "1",
      GOOGLE_APPLICATION_CREDENTIALS: "/x.json",
    },
    undefined,
    true,
    {},
    [...GEMINI_BACKEND.envDenyList],
  );
  assert.equal(env.GOOGLE_CLOUD_PROJECT, "engineering-478708");
  for (const key of GEMINI_BACKEND.envDenyList) {
    assert.equal(env[key], undefined, `${key} が残っている`);
  }
});

// ===== 4. preflight =====

test("preflight: claude は「確認すべきことなし」＝一切実行しない（外形ゼロ差分）", () => {
  assert.equal(needsPreflight(CLAUDE_BACKEND), false);
  assert.equal(needsPreflight(GEMINI_BACKEND), true);
});

test("preflight: OAuth 資格が無ければ error（spawn を止める）", () => {
  const spec = GEMINI_BACKEND.preflight;
  const ng = evaluatePreflight(spec, {
    home: "/home/x",
    fileExists: () => false,
    env: {},
    version: GEMINI_VERIFIED_VERSION,
  });
  assert.equal(ng.ok, false);
  assert.equal(ng.errors.length, 1);
  assert.match(ng.errors.join("\n"), /\/home\/x\/\.gemini\/oauth_creds\.json/);
});

// ボス裁定 2026-09-05（変更）: 個人 Google アカウント運用では GOOGLE_CLOUD_PROJECT を
// 設定しない（設定すると GCP 紐付き経路に載る）。Workspace 垢では逆に必須。
// ebi-team はアカウント種別を決め打ちせず、「あれば継承・無ければ無し」で起動する。
test("preflight: GOOGLE_CLOUD_PROJECT は必須にしない（個人垢／Workspace 垢の両対応）", () => {
  const spec = GEMINI_BACKEND.preflight;
  assert.deepEqual([...spec.requiredEnv], []);
  const withProject = evaluatePreflight(spec, {
    home: "/home/x",
    fileExists: (p) => p === "/home/x/.gemini/oauth_creds.json",
    env: { GOOGLE_CLOUD_PROJECT: "engineering-478708" },
    version: GEMINI_VERIFIED_VERSION,
  });
  const withoutProject = evaluatePreflight(spec, {
    home: "/home/x",
    fileExists: (p) => p === "/home/x/.gemini/oauth_creds.json",
    env: {},
    version: GEMINI_VERIFIED_VERSION,
  });
  assert.deepEqual(withProject, { ok: true, errors: [], warnings: [] });
  assert.deepEqual(withoutProject, { ok: true, errors: [], warnings: [] });
});

test("Workspace 垢で GOOGLE_CLOUD_PROJECT 未設定のときは起動時エラーを明示する", () => {
  const fatal = GEMINI_BACKEND.fatalPatterns ?? [];
  assert.equal(fatal.length >= 1, true);
  const hit = fatal.find((f) =>
    f.pattern.test(
      "This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID env var.",
    ),
  );
  assert.notEqual(hit, undefined);
  assert.match(hit.message, /GOOGLE_CLOUD_PROJECT/);
  // claude は致命パターンを持たない（外形ゼロ差分）。
  assert.equal(CLAUDE_BACKEND.fatalPatterns, undefined);
});

test("ready 判定はプロンプト表示（沈黙するダイアログで誤昇格しない）", () => {
  const pattern = GEMINI_BACKEND.readyPattern;
  assert.notEqual(pattern, null);
  assert.equal(pattern.test("⠴ Waiting for authentication... (Press Esc or Ctrl+C to cancel)"), false);
  assert.equal(pattern.test(" *   Type your message or @path/to/file"), true);
  // claude は従来どおり（boot 猶予＋初回 idle）。
  assert.equal(CLAUDE_BACKEND.readyPattern, undefined);
});

test("preflight: 検証済みバージョンと違っても止めない（自動更新でズレるため warning）", () => {
  const r = evaluatePreflight(GEMINI_BACKEND.preflight, {
    home: "/home/x",
    fileExists: () => true,
    env: { GOOGLE_CLOUD_PROJECT: "p" },
    version: "0.99.0",
  });
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], new RegExp(GEMINI_VERIFIED_VERSION));
});

// ===== 5. kill のプロセスグループ分岐 =====

test("kill: gemini はプロセスグループへ送る（負の pid）・claude は従来どおり", () => {
  assert.equal(BACKEND_TRAITS.gemini.killProcessGroup, true);
  assert.equal(BACKEND_TRAITS.claude.killProcessGroup, false);
  assert.equal(BACKEND_TRAITS.gemini.retryOnEarlyExit, true);
  assert.equal(BACKEND_TRAITS.claude.retryOnEarlyExit ?? false, false);

  const sent: { pid: number; sig: string }[] = [];
  const ok = killProcessGroupSignal(4242, "SIGTERM", (pid, sig) => {
    sent.push({ pid, sig });
  });
  assert.equal(ok, true);
  assert.deepEqual(sent, [{ pid: -4242, sig: "SIGTERM" }]);

  // 既に死んでいる（ESRCH）等は握り潰して false を返す（kill 経路を落とさない）。
  assert.equal(
    killProcessGroupSignal(4242, "SIGKILL", () => {
      throw new Error("ESRCH");
    }),
    false,
  );
  // 不正 pid（0 / 1 / 負）へは絶対に送らない（全プロセスへの誤爆防止）。
  let called = false;
  for (const pid of [0, 1, -1, Number.NaN]) {
    assert.equal(
      killProcessGroupSignal(pid, "SIGTERM", () => {
        called = true;
      }),
      false,
    );
  }
  assert.equal(called, false);
});

// ===== 6. 中立表現の往復 =====

test("ControlMcpSpec の往復: gemini settings → 元の command/args/cwd が保たれる", () => {
  const spec: ControlMcpSpec = controlMcpSpecFromClaudeConfig(CLAUDE_MCP_JSON, {
    agentId: "ebi-1",
  });
  const settings = buildGeminiSettings(spec);
  const entry = settings.mcpServers["ebi-control"];
  assert.equal(entry.command, spec.command);
  assert.deepEqual(entry.args, [...spec.args]);
  assert.equal(entry.cwd, spec.cwd);
  assert.deepEqual(entry.env, spec.env);
});
