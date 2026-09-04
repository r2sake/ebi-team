// PR-D（Codex CLI バックエンド）の純関数テスト。
//
// 対象:
//   1. buildArgs の外形固定（PoC 実証済みの起動形と一字一句そろえる）
//   2. permissionMode → `-s`（サンドボックス）写像
//   3. フォルダ信頼の `-c projects={...}`（インラインテーブル・重複除去）
//   4. preflight の分岐（認証ファイル欠如=error / バージョン差=warning）
//   5. backend の性質（channel 非対応 / 制御ブリッジ判定 / 初回注入 / ready パターン）
//   6. claude の外形ゼロ差分（PR-D で増えた入力フィールドを claude が無視すること）

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BACKEND_TRAITS,
  CLAUDE_BACKEND,
  CODEX_BACKEND,
  EBI_CONTROL_MCP_NAME,
  buildLaunchArgs,
  codexSandboxFor,
  evaluatePreflight,
  getBackend,
  initialInjectFor,
  resolveBackend,
  resolveBackendId,
  toCodexProjectsTrustArgs,
  type BackendLaunchInput,
  type ControlMcpSpec,
  type PermissionMode,
} from "../src/server/backends/index.ts";

const REPO = "/repo";
const WORKTREE = "/repo/.worktrees/ebi-1";

const SPEC: ControlMcpSpec = {
  name: EBI_CONTROL_MCP_NAME,
  command: "node",
  args: ["/repo/dist/server/mcp/control-server.js"],
  cwd: REPO,
  env: {
    EBI_CONTROL_URL: "http://127.0.0.1:8787",
    EBI_MCP_ROLE: "engineer",
    EBI_ID: "ebi-1",
    EBI_NOTIFY_SUBSCRIBE: "off",
  },
};

/** 既定の起動入力（役割付きエビ・worktree 起動を想定）。 */
function input(over: Partial<BackendLaunchInput> = {}): BackendLaunchInput {
  return {
    model: null,
    permissionMode: null,
    systemPrompt: null,
    mcpConfigPath: null,
    controlMcp: null,
    trustPaths: [],
    notifyMode: true,
    extraArgs: [],
    ...over,
  };
}

// ===== 1. buildArgs の外形固定 =====

test("codex buildArgs: 制御MCP 無し・最小形（起動ゲート 3 点を潰すフラグは常に付く）", () => {
  assert.deepEqual(CODEX_BACKEND.buildArgs(input()), [
    "--no-alt-screen",
    "-s", "read-only",
    "-a", "never",
    "-c", "disable_paste_burst=true",
    "-c", "check_for_update_on_startup=false",
    "-c", "features.apps=false",
  ]);
});

test("codex buildArgs: PoC 実証済みのフル形（model / trust / 制御MCP / extraArgs）", () => {
  const args = CODEX_BACKEND.buildArgs(
    input({
      model: "gpt-5.5",
      permissionMode: "bypassPermissions",
      // systemPrompt は**引数に載せない**（ready 後の PTY 注入で渡す）。
      systemPrompt: "あなたはエビチームの engineer エビ。",
      controlMcp: SPEC,
      trustPaths: [REPO, WORKTREE],
      extraArgs: ["--extra"],
    }),
  );
  assert.deepEqual(args, [
    "--no-alt-screen",
    "-m", "gpt-5.5",
    "-s", "danger-full-access",
    "-a", "never",
    "-c", "disable_paste_burst=true",
    "-c", "check_for_update_on_startup=false",
    "-c", "features.apps=false",
    "-c", `projects={"${REPO}"={trust_level="trusted"},"${WORKTREE}"={trust_level="trusted"}}`,
    "-c", 'mcp_servers.ebi-control.command="node"',
    "-c", 'mcp_servers.ebi-control.args=["/repo/dist/server/mcp/control-server.js"]',
    "-c", 'mcp_servers.ebi-control.cwd="/repo"',
    "-c", 'mcp_servers.ebi-control.default_tools_approval_mode="approve"',
    "-c",
      'mcp_servers.ebi-control.env={EBI_CONTROL_URL="http://127.0.0.1:8787",' +
      'EBI_MCP_ROLE="engineer",EBI_ID="ebi-1",EBI_NOTIFY_SUBSCRIBE="off"}',
    "-c", "mcp_servers.ebi-control.startup_timeout_sec=60",
    "--extra",
  ]);
  // 役割プロンプトが引数に混ざっていないこと（位置引数を使わないのが PR-D の方針）。
  assert.equal(args.includes("あなたはエビチームの engineer エビ。"), false);
});

test("codex は command 名から解決でき、buildLaunchArgs 経由でも同じ外形になる", () => {
  assert.equal(resolveBackend("codex")?.id, "codex");
  assert.equal(resolveBackend("/opt/homebrew/bin/codex")?.id, "codex");
  assert.equal(resolveBackendId({ env: "codex" }), "codex");
  assert.equal(getBackend("codex").defaultCommand, "codex");
  const i = input({ controlMcp: SPEC, trustPaths: [REPO] });
  assert.deepEqual(buildLaunchArgs("codex", i), CODEX_BACKEND.buildArgs(i));
});

// ===== 2. permissionMode 写像 =====

test("permissionMode → codex -s の写像（既定は読み取り寄り）", () => {
  const table: [PermissionMode | null, string][] = [
    [null, "read-only"],
    ["default", "read-only"],
    ["plan", "read-only"],
    ["acceptEdits", "workspace-write"],
    ["auto", "workspace-write"],
    ["dontAsk", "workspace-write"],
    ["bypassPermissions", "danger-full-access"],
  ];
  for (const [mode, sandbox] of table) {
    assert.equal(codexSandboxFor(mode), sandbox, `${mode} の写像`);
    const args = CODEX_BACKEND.buildArgs(input({ permissionMode: mode }));
    assert.equal(args[args.indexOf("-s") + 1], sandbox);
    // 承認は常に never（on-request は無人運用で固まるため使わない）。
    assert.equal(args[args.indexOf("-a") + 1], "never");
  }
});

// ===== 3. フォルダ信頼 =====

test("toCodexProjectsTrustArgs: 空なら付けない・重複は除去・インラインテーブル形式", () => {
  assert.deepEqual(toCodexProjectsTrustArgs([]), []);
  assert.deepEqual(toCodexProjectsTrustArgs(["", ""]), []);
  assert.deepEqual(toCodexProjectsTrustArgs([REPO, REPO]), [
    "-c", `projects={"${REPO}"={trust_level="trusted"}}`,
  ]);
  const [flag, value] = toCodexProjectsTrustArgs([REPO, WORKTREE]);
  assert.equal(flag, "-c");
  // ドット記法（黙って無視される形）になっていないこと。
  assert.equal(value.startsWith("projects={"), true);
  assert.equal(value.includes('projects."'), false);
});

// ===== 4. preflight の分岐 =====

test("codex preflight: login チェックが宣言されている（codex login status・stderr 出力）", () => {
  const login = BACKEND_TRAITS.codex.preflight.loginCheck;
  assert.ok(login, "loginCheck が無い");
  assert.deepEqual([...login.args], ["login", "status"]);
  assert.equal(login.okPattern.test("Logged in using ChatGPT"), true);
  assert.equal(login.okPattern.test("Not logged in"), false);
});

test("codex preflight: 認証ファイルが無ければ error（spawn を止める）", () => {
  const r = evaluatePreflight(BACKEND_TRAITS.codex.preflight, {
    home: "/home/boss",
    fileExists: () => false,
    env: {},
    version: "codex-cli 0.146.0",
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /\/home\/boss\/\.codex\/auth\.json/);
});

test("codex preflight: 検証済みバージョンと違っても warning 止まり（起動は続ける）", () => {
  const r = evaluatePreflight(BACKEND_TRAITS.codex.preflight, {
    home: "/home/boss",
    fileExists: (p) => p === "/home/boss/.codex/auth.json",
    env: {},
    version: "codex-cli 0.153.2",
  });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.match(r.warnings.join("\n"), /0\.146\.0/);
});

test("codex preflight: 検証済みバージョン一致なら警告ゼロ", () => {
  const r = evaluatePreflight(BACKEND_TRAITS.codex.preflight, {
    home: "/home/boss",
    fileExists: (p) => p === "/home/boss/.codex/auth.json",
    env: {},
    version: "codex-cli 0.146.0",
  });
  assert.deepEqual(r, { ok: true, errors: [], warnings: [] });
});

// ===== 5. backend の性質 =====

test("codex は channel 注入非対応（PTY 注入経路に落ちる）・起動ゲート定義を持たない", () => {
  assert.equal(CODEX_BACKEND.supportsChannelInject, false);
  assert.equal(CODEX_BACKEND.startupGates, null);
  // 位置引数プロンプトは CLI 能力としては可だが、運用では使わない（MCP 起動と競合するため）。
  assert.equal(CODEX_BACKEND.supportsInitialPrompt, false);
  assert.deepEqual(CODEX_BACKEND.initialPromptArgs("TASK"), []);
  assert.deepEqual(BACKEND_TRAITS.codex.initialPromptArgs("TASK"), ["TASK"]);
  // codex はフラグでインライン描画するので env の既定は不要。
  assert.deepEqual(CODEX_BACKEND.buildEnv({ agentId: "ebi-1" }), {});
});

test("codex hasControlBridge: -c mcp_servers.ebi-control.* があるときだけ true", () => {
  assert.equal(
    CODEX_BACKEND.hasControlBridge(CODEX_BACKEND.buildArgs(input({ controlMcp: SPEC }))),
    true,
  );
  assert.equal(CODEX_BACKEND.hasControlBridge(CODEX_BACKEND.buildArgs(input())), false);
});

test("codex の初回注入は役割プロンプト（無ければ null）", () => {
  const prompt = "あなたはエビチームの engineer エビ。";
  assert.equal(initialInjectFor("codex", input({ systemPrompt: prompt })), prompt);
  assert.equal(initialInjectFor("codex", input({ systemPrompt: "   " })), null);
  assert.equal(initialInjectFor("codex", input()), null);
  // claude は起動引数（--append-system-prompt）で渡すので初回注入しない。
  assert.equal(initialInjectFor("claude", input({ systemPrompt: prompt })), null);
  // スタブ起動（bash 等）も注入しない。
  assert.equal(initialInjectFor("bash", input({ systemPrompt: prompt })), null);
});

test("codex は ready 昇格に追加猶予を持つ（MCP ツール登録待ち）", () => {
  assert.equal(typeof CODEX_BACKEND.readyWarmupMs, "number");
  assert.ok((CODEX_BACKEND.readyWarmupMs ?? 0) > 0);
  // claude は従来どおり猶予なし（挙動不変）。
  assert.equal(CLAUDE_BACKEND.readyWarmupMs, undefined);
});

test("codex の readyPattern は起動バナー（ANSI 除去済み素文）に一致する", () => {
  const pattern = CODEX_BACKEND.readyPattern!;
  // agent.ts の maybeMarkReadyPattern は ANSI を落とすだけで空白は保持する。
  assert.equal(pattern.test("│ >_ OpenAI Codex (v0.146.0)                       │"), true);
  assert.equal(pattern.test("something else"), false);
});

test("codex の fatalPatterns は起動ゲート/ログイン要求を拾う", () => {
  const hit = (text: string) =>
    (CODEX_BACKEND.fatalPatterns ?? []).some((f) => f.pattern.test(text));
  assert.equal(hit("Do you trust the contents of this directory?"), true);
  assert.equal(hit("✨ Update available! 1. Update now"), true);
  assert.equal(hit("Not logged in"), true);
  assert.equal(hit("通常の出力"), false);
  // ready 前に落ちたら 1 回だけ再 spawn する（PR-C の watchEarlyExit に相乗り）。
  assert.equal(CODEX_BACKEND.retryOnEarlyExit, true);
});

// ===== 6. claude の外形ゼロ差分 =====

test("PR-D で増えた入力（controlMcp / trustPaths）を claude は無視する", () => {
  const base = input({
    model: "opus",
    permissionMode: "bypassPermissions",
    systemPrompt: "ROLE",
    mcpConfigPath: "/repo/.ebi-team/engineer-control.mcp.json",
  });
  const withNewFields = { ...base, controlMcp: SPEC, trustPaths: [REPO, WORKTREE] };
  assert.deepEqual(
    CLAUDE_BACKEND.buildArgs(withNewFields),
    CLAUDE_BACKEND.buildArgs({ ...base, controlMcp: null, trustPaths: [] }),
  );
  assert.deepEqual(buildLaunchArgs("claude", withNewFields), [
    "--model", "opus",
    "--permission-mode", "bypassPermissions",
    "--append-system-prompt", "ROLE",
    "--mcp-config", "/repo/.ebi-team/engineer-control.mcp.json",
    "--dangerously-load-development-channels", "server:ebi-control",
  ]);
});
