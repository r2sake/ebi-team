// pty に渡す env の組み立て（buildSpawnEnv）の純関数ユニットテスト。
//
// 目的: claude TUI を代替スクリーン（ESC[?1049h）ではなく通常バッファへインライン描画させる
// 既定 env が、親 env / launch.env を壊さずに「最下位優先」で敷かれることを保証する。
// 代替スクリーンのままだと xterm.js がスクロールバックを持てず、/compact 等の全画面再描画後に
// ブラウザ側でログを遡れなくなる（本テストはその再発防止）。
//
// 実行: node --import tsx --test test/spawnEnv.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnEnv } from "../src/server/agent.ts";

test("インライン TUI 既定 env が注入される", () => {
  const env = buildSpawnEnv({ PATH: "/usr/bin" }, undefined, true);
  assert.equal(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN, "1");
  assert.equal(env.CLAUDE_CODE_DISABLE_MOUSE, "1");
  assert.equal(env.PATH, "/usr/bin");
});

test("inlineTui=false なら注入しない（従来挙動）", () => {
  const env = buildSpawnEnv({ PATH: "/usr/bin" }, undefined, false);
  assert.equal(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN, undefined);
  assert.equal(env.CLAUDE_CODE_DISABLE_MOUSE, undefined);
});

test("親 env の明示指定が既定より優先される", () => {
  const env = buildSpawnEnv(
    { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "0", PATH: "/usr/bin" },
    undefined,
    true,
  );
  assert.equal(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN, "0");
});

test("launch.env が最優先（EBI_ID 等の注入が壊れない）", () => {
  const env = buildSpawnEnv(
    { EBI_ID: "parent", PATH: "/usr/bin" },
    { EBI_ID: "eng-1", CLAUDE_CODE_DISABLE_MOUSE: "0" },
    true,
  );
  assert.equal(env.EBI_ID, "eng-1");
  assert.equal(env.CLAUDE_CODE_DISABLE_MOUSE, "0");
  assert.equal(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN, "1");
  assert.equal(env.PATH, "/usr/bin");
});

test("undefined 値の親 env キーで既定が握り潰されない", () => {
  const env = buildSpawnEnv(
    { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: undefined, PATH: "/usr/bin" },
    undefined,
    true,
  );
  assert.equal(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN, "1");
});
