// MasterBrain（claude ヘッドレス master）の起動引数・env deny list・preflight の純関数テスト。
//
// 守りたい不変条件:
//  - PoC で実測して通った引数列（docs/poc/master-headless-poc-2026-09-05.md §1）から外れない。
//  - `--bare` と `ANTHROPIC_API_KEY` 系が **絶対に master プロセスへ届かない**
//    （届いた瞬間サブスク OAuth を外れて従量課金に落ちる）。
//  - `--model` を必ず明示する（CLI の既定モデルは opus ではない・PoC §5-H）。
//
// 実行: node --import tsx --test test/masterBrainArgs.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMasterEnvDenyList,
  buildClaudeHeadlessArgs,
  DEFAULT_CLAUDE_MASTER_MODEL,
  evaluateInitApiKeySource,
  evaluateMasterPreflight,
  MASTER_ENV_DENY_LIST,
} from "../src/server/master/claudeArgs.ts";
import {
  createMasterBrain,
  isImplementedMasterBrain,
  MasterBrainNotImplementedError,
  MasterCostLedger,
  unsupportedOf,
  CODEX_BRAIN_CAPABILITIES,
  CLAUDE_BRAIN_CAPABILITIES,
} from "../src/server/master/index.ts";

const base = {
  model: null,
  permissionMode: null,
  systemPrompt: null,
  mcpConfigPath: null,
  resumeSessionId: null,
  extraArgs: [] as string[],
};

test("stream-json 双方向の基幹フラグが必ず付く", () => {
  const args = buildClaudeHeadlessArgs(base);
  assert.deepEqual(args.slice(0, 7), [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--replay-user-messages",
  ]);
});

test("model 未指定でも --model が明示される（既定モデルは opus ではないため）", () => {
  const args = buildClaudeHeadlessArgs(base);
  const i = args.indexOf("--model");
  assert.ok(i >= 0);
  assert.equal(args[i + 1], DEFAULT_CLAUDE_MASTER_MODEL);
});

test("model 指定はそのまま渡る", () => {
  const args = buildClaudeHeadlessArgs({ ...base, model: "fable" });
  assert.equal(args[args.indexOf("--model") + 1], "fable");
});

test("mcpConfigPath があれば --mcp-config と --strict-mcp-config が対で付く", () => {
  const args = buildClaudeHeadlessArgs({ ...base, mcpConfigPath: "/tmp/master.mcp.json" });
  assert.equal(args[args.indexOf("--mcp-config") + 1], "/tmp/master.mcp.json");
  assert.ok(args.includes("--strict-mcp-config"));
});

test("mcpConfigPath が無ければ MCP 系フラグは一切付かない", () => {
  const args = buildClaudeHeadlessArgs(base);
  assert.ok(!args.includes("--mcp-config"));
  assert.ok(!args.includes("--strict-mcp-config"));
});

test("permissionMode / systemPrompt / resume が渡る", () => {
  const args = buildClaudeHeadlessArgs({
    ...base,
    permissionMode: "auto",
    systemPrompt: "あなたは master です",
    resumeSessionId: "sess-1",
  });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "auto");
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], "あなたは master です");
  assert.equal(args[args.indexOf("--resume") + 1], "sess-1");
});

test("--include-partial-messages は既定で付かない（PoC 未検証のため）", () => {
  assert.ok(!buildClaudeHeadlessArgs(base).includes("--include-partial-messages"));
  assert.ok(
    buildClaudeHeadlessArgs({ ...base, includePartialMessages: true }).includes(
      "--include-partial-messages",
    ),
  );
});

test("extraArgs は常に末尾", () => {
  const args = buildClaudeHeadlessArgs({ ...base, extraArgs: ["--effort", "medium"] });
  assert.deepEqual(args.slice(-2), ["--effort", "medium"]);
});

test("--bare は組み立てでは決して現れない", () => {
  const args = buildClaudeHeadlessArgs({
    ...base,
    model: "opus",
    permissionMode: "auto",
    systemPrompt: "x",
    mcpConfigPath: "/tmp/x.json",
    resumeSessionId: "s",
    includePartialMessages: true,
    extraArgs: ["--effort", "medium"],
  });
  assert.ok(!args.includes("--bare"));
});

test("env deny list が API キー系を落とし、それ以外は残す", () => {
  const child = applyMasterEnvDenyList({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-xxx",
    ANTHROPIC_AUTH_TOKEN: "tok",
    ANTHROPIC_BASE_URL: "https://example",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    EBI_ID: "master",
  });
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.EBI_ID, "master");
  for (const key of MASTER_ENV_DENY_LIST) {
    assert.ok(!Object.prototype.hasOwnProperty.call(child, key), `${key} が残っている`);
  }
});

test("deny 対象が値 undefined でもキーごと落ちる", () => {
  const child = applyMasterEnvDenyList({ ANTHROPIC_API_KEY: undefined, PATH: "/bin" });
  assert.ok(!Object.prototype.hasOwnProperty.call(child, "ANTHROPIC_API_KEY"));
});

test("preflight: 正常系は ok", () => {
  const r = evaluateMasterPreflight({
    args: buildClaudeHeadlessArgs(base),
    childEnv: { PATH: "/usr/bin" },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("preflight: --bare は起動拒否", () => {
  const r = evaluateMasterPreflight({ args: ["-p", "--bare"], childEnv: {} });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(""), /--bare/);
});

test("preflight: --bare=value 形式も拒否", () => {
  const r = evaluateMasterPreflight({ args: ["-p", "--bare=true"], childEnv: {} });
  assert.equal(r.ok, false);
});

test("preflight: deny 対象が子 env に残っていたら起動拒否（適用漏れの検出）", () => {
  const r = evaluateMasterPreflight({
    args: ["-p"],
    childEnv: { ANTHROPIC_API_KEY: "sk-xxx" },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(""), /ANTHROPIC_API_KEY/);
});

test("preflight: 親 env にあった deny 対象は warning として残る（黙って消さない）", () => {
  const parentEnv = { ANTHROPIC_API_KEY: "sk-xxx", PATH: "/bin" };
  const r = evaluateMasterPreflight({
    args: ["-p"],
    childEnv: applyMasterEnvDenyList(parentEnv),
    parentEnv,
  });
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(""), /ANTHROPIC_API_KEY/);
});

test("preflight: --permission-prompts none は警告（AskUserQuestion が消えるため）", () => {
  const r = evaluateMasterPreflight({
    args: ["-p", "--permission-prompts", "none"],
    childEnv: {},
  });
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(""), /AskUserQuestion/);
});

test("apiKeySource: none なら ok / それ以外は起動拒否 / 欠測は警告どまり", () => {
  assert.equal(evaluateInitApiKeySource("none").ok, true);
  const ng = evaluateInitApiKeySource("ANTHROPIC_API_KEY");
  assert.equal(ng.ok, false);
  assert.match(ng.errors.join(""), /apiKeySource/);
  const missing = evaluateInitApiKeySource(undefined);
  assert.equal(missing.ok, true);
  assert.equal(missing.warnings.length, 1);
});

test("コストはプロセスを跨いで足し込む（resume でリセットされる分を吸収）", () => {
  const ledger = new MasterCostLedger();
  // run1: プロセス内で積算されていく（上書き）
  ledger.noteProcessTotal("p1", 0.159537);
  ledger.noteProcessTotal("p1", 0.247826);
  // run2: --resume で 0 から数え直し
  ledger.noteProcessTotal("p2", 0.018906);
  assert.equal(ledger.processCount, 2);
  assert.ok(Math.abs(ledger.total() - 0.266732) < 1e-9);
  ledger.noteProcessTotal("p2", null);
  assert.ok(Math.abs(ledger.total() - 0.266732) < 1e-9);
});

test("unsupported は capabilities から導出される（二重管理を作らない）", () => {
  assert.deepEqual(unsupportedOf(CLAUDE_BRAIN_CAPABILITIES), []);
  assert.deepEqual(unsupportedOf(CODEX_BRAIN_CAPABILITIES).sort(), [
    "askUserQuestion",
    "contextPct",
    "cost",
    "thinking",
  ]);
});

test("createMasterBrain: 未実装 id は黙って claude へ落とさず明示エラー", () => {
  assert.equal(isImplementedMasterBrain("claude"), true);
  assert.equal(isImplementedMasterBrain("codex"), false);
  assert.equal(createMasterBrain("claude").id, "claude");
  assert.equal(createMasterBrain("codex").id, "codex");
  assert.throws(() => createMasterBrain("gemini"), MasterBrainNotImplementedError);
  assert.throws(() => createMasterBrain("agy"), MasterBrainNotImplementedError);
});

test("codex stub は呼ぶと明示エラー（静かに何もしないをしない）", async () => {
  const brain = createMasterBrain("codex");
  await assert.rejects(
    () =>
      brain.start({
        cwd: "/tmp",
        model: null,
        permissionMode: null,
        systemPrompt: null,
        controlMcp: null,
        mcpConfigPath: null,
        resumeSessionId: null,
        extraArgs: [],
      }),
    MasterBrainNotImplementedError,
  );
  assert.equal(brain.sessionId(), null);
});
