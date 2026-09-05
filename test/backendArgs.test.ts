// バックエンド抽象化（backends/）の「外形ゼロ差分」固定テスト。
//
// 目的:
//   リファクタ前（Claude 依存が index.ts / config.ts に直書きされていた状態）と、
//   リファクタ後（backends/claude.ts の buildArgs / buildEnv）で、
//   **生成される起動コマンドラインと pty env が完全に一致する**ことを機械的に保証する。
//
// 方法:
//   リファクタ前の実装をこのファイル内に `legacy*` として原文どおり写経し（下記 LEGACY 節）、
//   起動パラメータの全組み合わせ（マトリクス）に対して legacy と新実装の出力を突き合わせる。
//   将来 backends/claude.ts をいじって外形が変わったら、このテストが必ず落ちる。
//
// 対象の外形:
//   1. 動的エビ（index.ts:spawnAgent 経由。role / notify / command 種別の全組み合わせ）
//   2. 固定エビ（config.ts:buildClaudeArgs 経由）
//   3. pty env（agent.ts:buildSpawnEnv のバックエンド既定 env）
//   4. hasControlBridge（registry.ts の配送経路ゲート判定）

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildClaudeArgs, type PermissionMode } from "../src/server/config.ts";
import { buildSpawnEnv } from "../src/server/agent.ts";
import {
  buildLaunchArgs,
  resolveBackend,
  CLAUDE_BACKEND,
  EBI_CONTROL_CHANNEL_SPEC,
} from "../src/server/backends/index.ts";

// ===================== LEGACY（リファクタ前の実装・原文写経） =====================

/** リファクタ前 config.ts:buildClaudeArgs（f29418b 時点）。 */
function legacyBuildClaudeArgs(opts: {
  command: string;
  model?: string | null;
  permissionMode?: PermissionMode;
  appendSystemPrompt?: string | null;
  extraArgs?: string[];
}): string[] {
  const { command, model, permissionMode, appendSystemPrompt, extraArgs = [] } = opts;
  const isClaude = command === "claude" || command.endsWith("/claude");
  const args: string[] = [];
  if (isClaude) {
    if (model) args.push("--model", model);
    if (permissionMode) args.push("--permission-mode", permissionMode);
    if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);
  }
  args.push(...extraArgs);
  return args;
}

/** リファクタ前 index.ts:spawnAgent の起動引数組み立て（roleMcpArgs + buildClaudeArgs）。 */
function legacySpawnArgs(input: {
  command: string;
  model: string | null;
  permissionMode: PermissionMode;
  appendSystemPrompt: string | null;
  mcpConfigPath: string | null; // role がある場合の ROLE_MCP_CONFIG[role.mcpRole]
  notifyMode: boolean;
  serverArgs: string[]; // spawnConfig.args（EBI_ARGS 由来）
}): string[] {
  const { command, mcpConfigPath, notifyMode, serverArgs } = input;
  const isClaude = command === "claude" || command.endsWith("/claude");
  const roleMcpArgs =
    mcpConfigPath && isClaude
      ? [
          "--mcp-config",
          mcpConfigPath,
          ...(notifyMode
            ? ["--dangerously-load-development-channels", "server:ebi-control"]
            : []),
        ]
      : [];
  return legacyBuildClaudeArgs({
    command,
    model: input.model,
    permissionMode: input.permissionMode,
    appendSystemPrompt: input.appendSystemPrompt,
    extraArgs: [...roleMcpArgs, ...serverArgs],
  });
}

/** リファクタ前 agent.ts:INLINE_TUI_ENV。 */
const LEGACY_INLINE_TUI_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
  CLAUDE_CODE_DISABLE_MOUSE: "1",
};

/** リファクタ前 registry.ts:hasControlBridge。 */
function legacyHasControlBridge(command: string, args: string[]): boolean {
  const isClaude = command === "claude" || command.endsWith("/claude");
  return isClaude && args.includes("--mcp-config");
}

// ===================== マトリクス =====================

const COMMANDS = ["claude", "/opt/homebrew/bin/claude", "bash", "/bin/bash", "echo"];
const MODELS: (string | null)[] = [null, "claude-opus-5", "haiku"];
const PERMISSION_MODES_UNDER_TEST: PermissionMode[] = [
  "auto",
  "bypassPermissions",
  "acceptEdits",
  "plan",
];
const PROMPTS: (string | null)[] = [
  null,
  "あなたはエビチームの engineer エビ。\n改行と「日本語」と \"quote\" を含む長文プロンプト。",
];
const MCP_CONFIGS: (string | null)[] = [null, "/Users/x/ebi-team/.ebi-team/engineer-control.mcp.json"];
const NOTIFY_MODES = [true, false];
const SERVER_ARGS: string[][] = [[], ["--verbose"], ["--mcp-config", "/x/master-control.mcp.json"]];

test("外形ゼロ差分: 動的エビ spawn の起動引数がリファクタ前と完全一致する", () => {
  let cases = 0;
  for (const command of COMMANDS) {
    for (const model of MODELS) {
      for (const permissionMode of PERMISSION_MODES_UNDER_TEST) {
        for (const systemPrompt of PROMPTS) {
          for (const mcpConfigPath of MCP_CONFIGS) {
            for (const notifyMode of NOTIFY_MODES) {
              for (const serverArgs of SERVER_ARGS) {
                const expected = legacySpawnArgs({
                  command,
                  model,
                  permissionMode,
                  appendSystemPrompt: systemPrompt,
                  mcpConfigPath,
                  notifyMode,
                  serverArgs,
                });
                const actual = buildLaunchArgs(command, {
                  model,
                  permissionMode,
                  systemPrompt,
                  mcpConfigPath,
                  notifyMode,
                  extraArgs: [...serverArgs],
                });
                assert.deepEqual(
                  actual,
                  expected,
                  `不一致: command=${command} model=${model} pm=${permissionMode} ` +
                    `prompt=${systemPrompt ? "有" : "無"} mcp=${mcpConfigPath ? "有" : "無"} ` +
                    `notify=${notifyMode} serverArgs=${JSON.stringify(serverArgs)}`,
                );
                cases++;
              }
            }
          }
        }
      }
    }
  }
  // マトリクスが痩せて「実質何も検証していない」状態に退化していないことの番人。
  assert.equal(cases, 5 * 3 * 4 * 2 * 2 * 2 * 3);
});

test("外形ゼロ差分: 固定エビ（buildClaudeArgs）の起動引数がリファクタ前と完全一致する", () => {
  for (const command of COMMANDS) {
    for (const model of MODELS) {
      for (const permissionMode of PERMISSION_MODES_UNDER_TEST) {
        for (const appendSystemPrompt of PROMPTS) {
          for (const extraArgs of SERVER_ARGS) {
            const opts = { command, model, permissionMode, appendSystemPrompt, extraArgs };
            assert.deepEqual(buildClaudeArgs(opts), legacyBuildClaudeArgs(opts));
          }
        }
      }
    }
  }
});

test("起動引数の並び順スナップショット（役割付き engineer・notify 有効）", () => {
  const args = buildLaunchArgs("claude", {
    model: "claude-opus-5",
    permissionMode: "bypassPermissions",
    systemPrompt: "ROLE",
    mcpConfigPath: "/x/engineer-control.mcp.json",
    notifyMode: true,
    extraArgs: ["--verbose"],
  });
  assert.deepEqual(args, [
    "--model",
    "claude-opus-5",
    "--permission-mode",
    "bypassPermissions",
    "--append-system-prompt",
    "ROLE",
    "--mcp-config",
    "/x/engineer-control.mcp.json",
    "--dangerously-load-development-channels",
    "server:ebi-control",
    "--verbose",
  ]);
});

test("notify 無効なら dev-channels フラグが付かない（--mcp-config は付く）", () => {
  const args = buildLaunchArgs("claude", {
    model: null,
    permissionMode: null,
    systemPrompt: null,
    mcpConfigPath: "/x/engineer-control.mcp.json",
    notifyMode: false,
    extraArgs: [],
  });
  assert.deepEqual(args, ["--mcp-config", "/x/engineer-control.mcp.json"]);
});

test("非対応 command（bash 等のスタブ起動）には固有フラグを一切付けない", () => {
  const args = buildLaunchArgs("bash", {
    model: "claude-opus-5",
    permissionMode: "bypassPermissions",
    systemPrompt: "ROLE",
    mcpConfigPath: "/x/engineer-control.mcp.json",
    notifyMode: true,
    extraArgs: ["-lc", "sleep 1"],
  });
  assert.deepEqual(args, ["-lc", "sleep 1"]);
});

test("dev-channels の channel 指定子が server:ebi-control のまま（gen-master-mcp のキーと一致）", () => {
  assert.equal(EBI_CONTROL_CHANNEL_SPEC, "server:ebi-control");
});

test("外形ゼロ差分: pty env のバックエンド既定がリファクタ前と完全一致する", () => {
  assert.deepEqual(CLAUDE_BACKEND.buildEnv(), LEGACY_INLINE_TUI_ENV);
  // buildSpawnEnv 経由（優先度: バックエンド既定 < 親 env < launch.env）も一致すること。
  const parent = { PATH: "/usr/bin", HOME: "/Users/x" };
  const expected = { ...LEGACY_INLINE_TUI_ENV, ...parent, EBI_ID: "ebi-1" };
  assert.deepEqual(buildSpawnEnv(parent, { EBI_ID: "ebi-1" }, true), expected);
  assert.deepEqual(
    buildSpawnEnv(parent, { EBI_ID: "ebi-1" }, true, CLAUDE_BACKEND.buildEnv({ agentId: "ebi-1" })),
    expected,
  );
});

test("外形ゼロ差分: hasControlBridge の判定がリファクタ前と完全一致する", () => {
  const argSets: string[][] = [
    [],
    ["--model", "haiku"],
    ["--mcp-config", "/x/engineer-control.mcp.json"],
    ["--model", "haiku", "--mcp-config", "/x/a.json", "--dangerously-load-development-channels", "server:ebi-control"],
  ];
  for (const command of COMMANDS) {
    for (const args of argSets) {
      const backend = resolveBackend(command);
      const actual = backend !== null && backend.hasControlBridge(args, {});
      assert.equal(
        actual,
        legacyHasControlBridge(command, args),
        `不一致: command=${command} args=${JSON.stringify(args)}`,
      );
    }
  }
});
