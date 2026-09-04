// PR-E（役割ごとの既定 backend / config の backends 設定 / master fail-safe）の純関数テスト。
//
// 対象:
//   1. EbiRole.backend（組込み engineer は claude 固定 / カスタム役割の検証）
//   2. config の top-level defaultBackend / backends の正規化と検証
//   3. backend 解決の優先度（spawn 引数 > 役割 > config > env > claude）
//   4. master の backend fail-safe（config/env で他 backend を既定にしても master は claude）

import { test } from "node:test";
import assert from "node:assert/strict";

import { BUILTIN_ROLES, EBI_ROLES, registerCustomRoles, resolveRole } from "../src/server/roles.ts";
import {
  EMPTY_BACKEND_SETTINGS,
  normalizeBackendSettings,
  type FixedEbiSpec,
} from "../src/server/config.ts";
import { resolveBackendId } from "../src/server/backends/index.ts";
import { applyMasterBackendFailsafe } from "../src/server/fixedEbi.ts";

// ===== 1. EbiRole.backend =====

test("組込み engineer の既定 backend は claude のまま（実装役は claude 維持）", () => {
  assert.equal(BUILTIN_ROLES.engineer.backend, "claude");
  assert.equal(BUILTIN_ROLES.engineer.defaultModel, "claude-opus-5");
});

test("カスタム役割に backend を指定できる（実装済み id のみ）", () => {
  registerCustomRoles({
    researcher: { label: "調査", backend: "gemini", permissionMode: "plan" },
    "engineer-codex": { label: "実装2nd", backend: "codex", defaultModel: "gpt-5.5" },
  });
  assert.equal(resolveRole("researcher")?.backend, "gemini");
  assert.equal(resolveRole("engineer-codex")?.backend, "codex");
  assert.equal(resolveRole("engineer-codex")?.defaultModel, "gpt-5.5");
  // 非 claude 役割で defaultModel 未指定なら claude 語彙（sonnet）を勝手に付けない。
  assert.equal(resolveRole("researcher")?.defaultModel, "");
  // 後片付け（他テストへ漏らさない）。
  delete EBI_ROLES.researcher;
  delete EBI_ROLES["engineer-codex"];
});

test("カスタム役割の backend 未指定は undefined（サーバ既定へフォールバック）", () => {
  registerCustomRoles({ plain: { label: "素" } });
  assert.equal(resolveRole("plain")?.backend, undefined);
  // claude 語彙の既定モデルは従来どおり付く。
  assert.equal(resolveRole("plain")?.defaultModel, "sonnet");
  delete EBI_ROLES.plain;
});

test("カスタム役割の未知/未実装 backend は明示エラー", () => {
  assert.throws(
    () => registerCustomRoles({ bad: { backend: "gpt4all" } }),
    /backend が不正です: gpt4all/,
  );
  assert.throws(() => registerCustomRoles({ bad2: { backend: 42 } }), /backend は文字列/);
  assert.equal(EBI_ROLES.bad, undefined);
  assert.equal(EBI_ROLES.bad2, undefined);
});

// ===== 2. config の defaultBackend / backends =====

test("defaultBackend / backends を正規化できる", () => {
  const s = normalizeBackendSettings({
    defaultBackend: "claude",
    backends: {
      claude: { command: "claude" },
      codex: { command: "codex", defaultModel: "gpt-5.5" },
      gemini: { defaultModel: "gemini-flash-latest" },
    },
  });
  assert.equal(s.defaultBackend, "claude");
  assert.equal(s.backends.codex?.command, "codex");
  assert.equal(s.backends.codex?.defaultModel, "gpt-5.5");
  assert.equal(s.backends.gemini?.defaultModel, "gemini-flash-latest");
  assert.equal(s.backends.gemini?.command, undefined);
});

test("defaultBackend / backends 未指定は「既定なし」（従来どおり env → claude）", () => {
  const s = normalizeBackendSettings({});
  assert.deepEqual(s, EMPTY_BACKEND_SETTINGS);
});

test("config の不正な backend 指定は明示エラー（黙って claude に落とさない）", () => {
  assert.throws(() => normalizeBackendSettings({ defaultBackend: "gpt4all" }), /backend が不正です/);
  assert.throws(() => normalizeBackendSettings({ defaultBackend: 1 }), /文字列である必要/);
  assert.throws(
    () => normalizeBackendSettings({ backends: { gpt4all: {} } }),
    /backends のキーが不正です/,
  );
  assert.throws(
    () => normalizeBackendSettings({ backends: { codex: { command: 3 } } }),
    /command は文字列/,
  );
  assert.throws(() => normalizeBackendSettings({ backends: [] }), /オブジェクト/);
});

// ===== 3. 解決優先度 =====

test("backend 解決の優先度: spawn 引数 > 役割 > config > env > claude", () => {
  assert.equal(
    resolveBackendId({ explicit: "codex", role: "gemini", configDefault: "claude", env: "gemini" }),
    "codex",
  );
  assert.equal(resolveBackendId({ role: "gemini", configDefault: "claude", env: "codex" }), "gemini");
  assert.equal(resolveBackendId({ configDefault: "codex", env: "gemini" }), "codex");
  assert.equal(resolveBackendId({ env: "gemini" }), "gemini");
  assert.equal(resolveBackendId({}), "claude");
  // 空文字（env 未設定相当）は「指定なし」として次の候補へ落ちる。
  assert.equal(resolveBackendId({ explicit: "", role: null, env: "codex" }), "codex");
});

// ===== 4. master の fail-safe =====

/** テスト用の最小 FixedEbiSpec。 */
function spec(kind: FixedEbiSpec["kind"], backend: string): FixedEbiSpec {
  return {
    id: kind,
    kind,
    launch: { command: "claude", args: [], cwd: "/tmp", model: null, backend: backend as never },
    notifySubscribe: true,
  };
}

test("master の backend は claude に固定される（config/env で他 backend を既定にしても）", () => {
  assert.equal(applyMasterBackendFailsafe(spec("master", "codex")).launch.backend, "claude");
  assert.equal(applyMasterBackendFailsafe(spec("master", "gemini")).launch.backend, "claude");
});

test("master 以外の固定エビ・既に claude の master は素通し（同一参照）", () => {
  const supervisor = spec("supervisor", "codex");
  assert.equal(applyMasterBackendFailsafe(supervisor), supervisor);
  const master = spec("master", "claude");
  assert.equal(applyMasterBackendFailsafe(master), master);
});
