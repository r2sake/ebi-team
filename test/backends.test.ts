// PR-B（バックエンド抽象化の拡張）の純関数テスト。
//
// 対象:
//   1. ControlMcpSpec → 3 方言（claude / codex / gemini）射影の出力固定
//   2. gen-master-mcp.mjs の生成物ゼロ差分（claude 射影が従来の手書き構造と完全一致すること）
//   3. preflight（evaluatePreflight）の判定
//   4. envDenyList（buildSpawnEnv 経由・claude は外形ゼロ差分）
//   5. 未実装 / 未知 backend 指定が明示エラーになること
//   6. backend プロファイル（reportsUsage / idleThresholdMs / initialPromptArgs / killProcessGroup）

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_BACKEND_IDS,
  BACKEND_TRAITS,
  CLAUDE_BACKEND,
  DEFAULT_IDLE_THRESHOLD_MS,
  EBI_CONTROL_MCP_NAME,
  IMPLEMENTED_BACKEND_IDS,
  applyEnvDenyList,
  backendIdError,
  evaluatePreflight,
  expandHome,
  getBackend,
  isImplementedBackendId,
  isKnownBackendId,
  resolveBackendId,
  resolveIdleThresholdMs,
  toClaudeMcpConfig,
  toCodexConfigArgs,
  toGeminiSystemSettings,
  type ControlMcpSpec,
} from "../src/server/backends/index.ts";
import { buildSpawnEnv } from "../src/server/agent.ts";

/** テスト用の中立表現（実運用と同じ形）。 */
const SPEC: ControlMcpSpec = {
  name: EBI_CONTROL_MCP_NAME,
  command: "node",
  args: ["/repo/dist/server/mcp/control-server.js"],
  cwd: "/repo",
  env: {
    EBI_CONTROL_URL: "http://127.0.0.1:8787",
    EBI_MCP_ROLE: "engineer",
    EBI_ID: "ebi-1",
    EBI_NOTIFY_SUBSCRIBE: "off",
  },
};

// ===== 1. 3 方言射影 =====

test("claude 方言: --mcp-config へ渡す JSON（キー順まで固定）", () => {
  const config = toClaudeMcpConfig(SPEC);
  assert.deepEqual(config, {
    mcpServers: {
      "ebi-control": {
        command: "node",
        args: ["/repo/dist/server/mcp/control-server.js"],
        cwd: "/repo",
        env: {
          EBI_CONTROL_URL: "http://127.0.0.1:8787",
          EBI_MCP_ROLE: "engineer",
          EBI_ID: "ebi-1",
          EBI_NOTIFY_SUBSCRIBE: "off",
        },
      },
    },
  });
  // 出力ファイルはキー順まで含めてバイト一致させる必要がある（差分ゼロの担保）。
  assert.equal(
    JSON.stringify(config.mcpServers["ebi-control"]).slice(0, 20),
    '{"command":"node","a',
  );
});

test("codex 方言: -c インライン TOML（default_tools_approval_mode=approve を必ず含む）", () => {
  assert.deepEqual(toCodexConfigArgs(SPEC), [
    "-c", 'mcp_servers.ebi-control.command="node"',
    "-c", 'mcp_servers.ebi-control.args=["/repo/dist/server/mcp/control-server.js"]',
    "-c", 'mcp_servers.ebi-control.cwd="/repo"',
    "-c", 'mcp_servers.ebi-control.default_tools_approval_mode="approve"',
    "-c",
    'mcp_servers.ebi-control.env={EBI_CONTROL_URL="http://127.0.0.1:8787",EBI_MCP_ROLE="engineer",EBI_ID="ebi-1",EBI_NOTIFY_SUBSCRIBE="off"}',
  ]);
});

test("codex 方言: TOML 文字列のクォート/バックスラッシュをエスケープする", () => {
  const args = toCodexConfigArgs({ ...SPEC, cwd: '/re"po\\x' });
  assert.ok(args.includes('mcp_servers.ebi-control.cwd="/re\\"po\\\\x"'));
});

test("gemini 方言: system settings（folderTrust/autoUpdate 無効・trust:true）", () => {
  assert.deepEqual(toGeminiSystemSettings(SPEC), {
    ui: { useAlternateBuffer: false },
    security: { folderTrust: { enabled: false } },
    general: { enableAutoUpdate: false, checkForUpdates: false },
    mcpServers: {
      "ebi-control": {
        command: "node",
        args: ["/repo/dist/server/mcp/control-server.js"],
        cwd: "/repo",
        env: SPEC.env,
        trust: true,
      },
    },
  });
});

test("gemini 方言: authType を渡すと security.auth.selectedType が入る", () => {
  const settings = toGeminiSystemSettings(SPEC, { authType: "oauth-personal" });
  assert.deepEqual(settings.security.auth, { selectedType: "oauth-personal" });
});

test("射影は入力を共有しない（配列 / env のコピー）", () => {
  const config = toClaudeMcpConfig(SPEC);
  config.mcpServers["ebi-control"].args.push("X");
  config.mcpServers["ebi-control"].env.EBI_ID = "changed";
  assert.deepEqual(SPEC.args, ["/repo/dist/server/mcp/control-server.js"]);
  assert.equal(SPEC.env.EBI_ID, "ebi-1");
});

// ===== 2. gen-master-mcp.mjs の生成物ゼロ差分 =====

/** リファクタ前 scripts/gen-master-mcp.mjs の手書き構造（原文写経）。 */
function legacyMasterMcpConfig(role: string, command: string, args: string[], root: string, controlUrl: string) {
  return {
    mcpServers: {
      "ebi-control": {
        command,
        args,
        cwd: root,
        env: { EBI_CONTROL_URL: controlUrl, EBI_MCP_ROLE: role },
      },
    },
  };
}

test("外形ゼロ差分: gen-master-mcp の生成 JSON が中立表現からの射影と文字列一致する", () => {
  const root = "/Users/x/ebi-team";
  const url = "http://127.0.0.1:8787";
  for (const [role, command, args] of [
    ["master", "node", [`${root}/dist/server/mcp/control-server.js`]],
    ["engineer", "npx", ["tsx", `${root}/src/mcp/control-server.ts`]],
  ] as [string, string, string[]][]) {
    const legacy = legacyMasterMcpConfig(role, command, args, root, url);
    const projected = toClaudeMcpConfig({
      name: EBI_CONTROL_MCP_NAME,
      command,
      args,
      cwd: root,
      env: { EBI_CONTROL_URL: url, EBI_MCP_ROLE: role },
    });
    // 書き出しと同じ整形（JSON.stringify(config, null, 2) + "\n"）でバイト一致を要求する。
    assert.equal(
      JSON.stringify(projected, null, 2) + "\n",
      JSON.stringify(legacy, null, 2) + "\n",
      `role=${role} で生成物に差分がある`,
    );
  }
});

// ===== 3. preflight =====

const codexPreflight = BACKEND_TRAITS.codex.preflight;
const geminiPreflight = BACKEND_TRAITS.gemini.preflight;

test("expandHome は先頭 ~/ だけ展開する", () => {
  assert.equal(expandHome("~/.codex/auth.json", "/Users/x"), "/Users/x/.codex/auth.json");
  assert.equal(expandHome("/abs/path", "/Users/x"), "/abs/path");
  assert.equal(expandHome("~", "/Users/x"), "/Users/x");
});

test("preflight(codex): auth.json があれば ok・無ければ error", () => {
  const base = { home: "/Users/x", env: {}, version: "codex-cli 0.146.0" };
  const ok = evaluatePreflight(codexPreflight, {
    ...base,
    fileExists: (p) => p === "/Users/x/.codex/auth.json",
  });
  assert.deepEqual(ok, { ok: true, errors: [], warnings: [] });

  const ng = evaluatePreflight(codexPreflight, { ...base, fileExists: () => false });
  assert.equal(ng.ok, false);
  assert.match(ng.errors[0], /\/Users\/x\/\.codex\/auth\.json/);
});

// PR-C（ボス裁定 2026-09-05 の変更後）: 必須は oauth_creds.json のみ。
// GOOGLE_CLOUD_PROJECT は Workspace 垢では必須・個人垢では設定してはいけない、という
// 相反する条件があるため ebi-team 側で決め打ちせず、「あれば継承・無ければ無し」で起動する
// （Workspace 垢で未設定のときは gemini 自身の起動エラーを fatalPatterns が拾う）。
test("preflight(gemini): 必須は oauth_creds.json のみ（GOOGLE_CLOUD_PROJECT は任意）", () => {
  const fileExists = (p: string) => p === "/Users/x/.gemini/oauth_creds.json";
  const ok = evaluatePreflight(geminiPreflight, {
    home: "/Users/x",
    fileExists,
    env: { GOOGLE_CLOUD_PROJECT: "engineering-478708" },
    version: "0.58.0",
  });
  assert.deepEqual(ok, { ok: true, errors: [], warnings: [] });

  const noProject = evaluatePreflight(geminiPreflight, {
    home: "/Users/x",
    fileExists,
    env: {},
    version: "0.58.0",
  });
  assert.deepEqual(noProject, { ok: true, errors: [], warnings: [] });

  // 認証ファイルが無ければ error（未ログイン）。
  const noAuth = evaluatePreflight(geminiPreflight, {
    home: "/Users/x",
    fileExists: () => false,
    env: {},
    version: "0.58.0",
  });
  assert.equal(noAuth.ok, false);
});

test("preflight: バージョン差分は error ではなく warning（自動更新で簡単にズレるため）", () => {
  const r = evaluatePreflight(geminiPreflight, {
    home: "/Users/x",
    fileExists: () => true,
    env: { GOOGLE_CLOUD_PROJECT: "p" },
    version: "0.60.0",
  });
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /0\.58\.0/);

  const noVersion = evaluatePreflight(geminiPreflight, {
    home: "/Users/x",
    fileExists: () => true,
    env: { GOOGLE_CLOUD_PROJECT: "p" },
    version: null,
  });
  assert.equal(noVersion.ok, true);
  assert.equal(noVersion.warnings.length, 1);
});

test("preflight(claude): 必須ファイル / 必須 env 無し（現状踏襲で常に ok）", () => {
  const r = evaluatePreflight(CLAUDE_BACKEND.preflight, {
    home: "/Users/x",
    fileExists: () => false,
    env: {},
    version: "2.1.198 (Claude Code)",
  });
  assert.deepEqual(r, { ok: true, errors: [], warnings: [] });
});

// ===== 4. envDenyList =====

test("envDenyList: claude は空＝親 env をそのまま継承する（外形ゼロ差分）", () => {
  assert.deepEqual(CLAUDE_BACKEND.envDenyList, []);
  const parent = { PATH: "/usr/bin", GEMINI_API_KEY: "k", GOOGLE_CLOUD_PROJECT: "p" };
  assert.equal(applyEnvDenyList(parent, CLAUDE_BACKEND.envDenyList), parent);
  const env = buildSpawnEnv(parent, { EBI_ID: "ebi-1" }, true, CLAUDE_BACKEND.buildEnv(), CLAUDE_BACKEND.envDenyList);
  assert.equal(env.GEMINI_API_KEY, "k");
  assert.equal(env.GOOGLE_CLOUD_PROJECT, "p");
});

test("envDenyList: gemini は API キー系だけ落とし GOOGLE_CLOUD_PROJECT は残す", () => {
  const traits = BACKEND_TRAITS.gemini;
  assert.deepEqual(traits.envDenyList, [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_GENAI_USE_GCA",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ]);
  const parent = {
    PATH: "/usr/bin",
    GEMINI_API_KEY: "k1",
    GOOGLE_API_KEY: "k2",
    GOOGLE_APPLICATION_CREDENTIALS: "/creds.json",
    GOOGLE_CLOUD_PROJECT: "engineering-478708",
  };
  const env = buildSpawnEnv(parent, { EBI_ID: "ebi-1" }, false, {}, traits.envDenyList);
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    GOOGLE_CLOUD_PROJECT: "engineering-478708",
    EBI_ID: "ebi-1",
  });
});

test("envDenyList は ebi-team 自身が渡す env（launch.env / backend 既定 env）には効かない", () => {
  const env = buildSpawnEnv({}, { GEMINI_API_KEY: "explicit" }, true, { GEMINI_API_KEY: "backend" }, [
    "GEMINI_API_KEY",
  ]);
  assert.equal(env.GEMINI_API_KEY, "explicit");
});

// ===== 5. 未実装 / 未知 backend =====

// PR-C で gemini、PR-D で codex が実装済みになり、3 backend とも実装済みになった。
test("実装済みは claude / codex / gemini の 3 つ", () => {
  assert.deepEqual([...IMPLEMENTED_BACKEND_IDS], ["claude", "codex", "gemini"]);
  assert.deepEqual([...ALL_BACKEND_IDS], ["claude", "codex", "gemini"]);
  assert.equal(isImplementedBackendId("codex"), true);
  assert.equal(isImplementedBackendId("gemini"), true);
  assert.equal(isKnownBackendId("codex"), true);
  assert.equal(isKnownBackendId("gpt"), false);
});

test("型としては既知だが未実装の backend は『未実装』と分かるエラー文言になる", () => {
  // PR-D 時点で ALL_BACKEND_IDS はすべて実装済みなので、実際に throw させる id が無い。
  // ここで固定するのは**文言の分岐**（既知だが未実装 / そもそも知らない id）で、
  // 将来 BackendId を先に足して実装が後追いになったときに「黙って claude に落ちない」ことを守る。
  assert.match(backendIdError("gemini").message, /未実装/);
  assert.match(backendIdError("gpt").message, /backend が不正です/);
});

test("未知 backend の指定は『不正』エラーになる", () => {
  assert.throws(() => resolveBackendId({ explicit: "gpt" }), /backend が不正です: gpt/);
  assert.throws(() => resolveBackendId({ role: "gpt" }), /backend が不正です: gpt/);
  assert.throws(() => resolveBackendId({ env: "gpt" }), /backend が不正です: gpt/);
});

test("backend 未指定なら claude（解決優先度は spawn 引数 > 役割 > config > env）", () => {
  assert.equal(resolveBackendId(), "claude");
  assert.equal(resolveBackendId({ explicit: null, role: "", configDefault: null, env: null }), "claude");
  assert.equal(resolveBackendId({ explicit: "claude", env: "gpt" }), "claude");
});

// ===== 6. backend プロファイル =====

test("initialPromptArgs: claude=[] / codex=[prompt] / gemini=['-i', prompt]", () => {
  assert.deepEqual(BACKEND_TRAITS.claude.initialPromptArgs("TASK"), []);
  assert.deepEqual(BACKEND_TRAITS.codex.initialPromptArgs("TASK"), ["TASK"]);
  assert.deepEqual(BACKEND_TRAITS.gemini.initialPromptArgs("TASK"), ["-i", "TASK"]);
  assert.deepEqual(CLAUDE_BACKEND.initialPromptArgs("TASK"), []);
});

test("reportsUsage: claude のみ true（codex / gemini は UI で「—（未対応）」表示）", () => {
  assert.equal(BACKEND_TRAITS.claude.reportsUsage, true);
  assert.equal(BACKEND_TRAITS.codex.reportsUsage, false);
  assert.equal(BACKEND_TRAITS.gemini.reportsUsage, false);
});

test("idleThresholdMs: 3 backend とも上書きなし＝サーバ既定 900ms（PoC 実測）", () => {
  assert.equal(DEFAULT_IDLE_THRESHOLD_MS, 900);
  for (const id of ALL_BACKEND_IDS) {
    assert.equal(BACKEND_TRAITS[id].idleThresholdMs, null, `${id} が上書きしている`);
    assert.equal(resolveIdleThresholdMs(BACKEND_TRAITS[id].idleThresholdMs, 900), 900);
  }
  // 上書きがある場合はそちらが勝つ。
  assert.equal(resolveIdleThresholdMs(2000, 900), 2000);
});

test("killProcessGroup: 非 claude は true（子 MCP / 再 exec した node の孤児を残さない）", () => {
  assert.equal(BACKEND_TRAITS.claude.killProcessGroup, false);
  // codex は組込み MCP codex_apps ＋ ebi-control の 2 本が子で立つ（PR-D）。
  assert.equal(BACKEND_TRAITS.codex.killProcessGroup, true);
  assert.equal(BACKEND_TRAITS.gemini.killProcessGroup, true);
});

test("CLAUDE_BACKEND は profiles.ts の CLAUDE_TRAITS をそのまま持つ（SoT 二重化なし）", () => {
  const traits = BACKEND_TRAITS.claude;
  assert.deepEqual(CLAUDE_BACKEND.envDenyList, traits.envDenyList);
  assert.equal(CLAUDE_BACKEND.reportsUsage, traits.reportsUsage);
  assert.equal(CLAUDE_BACKEND.idleThresholdMs, traits.idleThresholdMs);
  assert.equal(CLAUDE_BACKEND.killProcessGroup, traits.killProcessGroup);
  assert.equal(CLAUDE_BACKEND.preflight, traits.preflight);
});
