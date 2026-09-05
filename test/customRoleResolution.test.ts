// カスタム役割（config の top-level "roles"）が master の spawn_ebi / send_message から
// 実際に指定できるようになるまでの経路の回帰テスト。
//
// 背景（2026-09-05 の実障害）:
//   master の spawn_ebi({role:"imagegen"}) が
//     Invalid arguments for tool spawn_ebi: expected "engineer"
//   で弾かれた。config の roles.imagegen は登録済みで、サーバ側も対応済みだったのに、
//   制御MCP ブリッジ（src/mcp/control-server.ts）が config を読めておらず
//   （cwd 直下しか見ていなかった）、role の zod enum が ["engineer"] で固まっていた。
//
// ここで担保するのは 2 点:
//   1. config 探索が cwd に依存しない（configPath.resolveConfigPath）
//   2. config に roles.imagegen があれば imagegen が「通る役割」になり、
//      未知の役割は**利用可能な役割名を列挙した**エラーで拒否される（roles.ts）

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import {
  EBI_ROLES,
  availableRoleIds,
  registerCustomRoles,
  resolveRole,
  unknownRoleError,
} from "../src/server/roles.ts";
import { loadRawCustomRoles } from "../src/server/config.ts";
import { CONFIG_FILE_NAME, resolveConfigPath } from "../src/mcp/configPath.ts";

// ===== 1. config パス解決（cwd 非依存） =====

/** POSIX 固定のパス操作（プラットフォーム差をテストに持ち込まない）。 */
const posix = {
  join: (...parts: string[]) => parts.join("/").replace(/\/+/g, "/"),
  dirname: (p: string) => {
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
  },
};

/** 与えたパス集合だけが存在するファイルシステムの模擬。 */
const existsIn = (paths: string[]) => (p: string) => paths.includes(p);

test("env EBI_CONFIG_PATH が最優先（存在判定より前）", () => {
  const r = resolveConfigPath({
    envPath: "/explicit/ebi-team.config.json",
    cwd: "/anywhere",
    moduleDir: "/repo/src/mcp",
    exists: existsIn([`/repo/${CONFIG_FILE_NAME}`]),
    ...posix,
  });
  assert.deepEqual(r, { path: "/explicit/ebi-team.config.json", source: "env" });
});

test("cwd 直下に config があれば従来どおりそれを使う", () => {
  const r = resolveConfigPath({
    envPath: undefined,
    cwd: "/repo",
    moduleDir: "/repo/dist/server/mcp",
    exists: existsIn([`/repo/${CONFIG_FILE_NAME}`]),
    ...posix,
  });
  assert.equal(r.source, "cwd");
  assert.equal(r.path, `/repo/${CONFIG_FILE_NAME}`);
});

test("【回帰】cwd が別プロジェクトでもモジュール位置から上へ辿って config を見つける", () => {
  // 実障害の再現形: ブリッジは master セッションの cwd（別リポジトリ）で起動していた。
  for (const moduleDir of ["/repo/src/mcp", "/repo/dist/server/mcp"]) {
    const r = resolveConfigPath({
      envPath: undefined,
      cwd: "/Users/me/other-project",
      moduleDir,
      exists: existsIn([`/repo/${CONFIG_FILE_NAME}`]),
      ...posix,
    });
    assert.equal(r.source, "module", `moduleDir=${moduleDir}`);
    assert.equal(r.path, `/repo/${CONFIG_FILE_NAME}`);
  }
});

test("worktree 配下の dist から起動しても親リポジトリの config に届く", () => {
  const r = resolveConfigPath({
    envPath: undefined,
    cwd: "/tmp",
    moduleDir: "/repo/.worktrees/wt1/dist/server/mcp",
    exists: existsIn([`/repo/${CONFIG_FILE_NAME}`]),
    ...posix,
  });
  assert.equal(r.path, `/repo/${CONFIG_FILE_NAME}`);
});

test("どこにも無ければ missing（呼び出し側が警告を出せる）", () => {
  const r = resolveConfigPath({
    envPath: undefined,
    cwd: "/nowhere",
    moduleDir: "/a/b/c",
    exists: existsIn([]),
    ...posix,
  });
  assert.equal(r.source, "missing");
  assert.equal(r.path, `/nowhere/${CONFIG_FILE_NAME}`);
});

// ===== 2. config の roles → 役割レジストリ → role 検証 =====

test("config に roles.imagegen があれば role:\"imagegen\" が通る", async () => {
  // 実運用と同じ経路（ファイル → loadRawCustomRoles → registerCustomRoles）で確かめる。
  const dir = mkdtempSync(pathJoin(tmpdir(), "ebi-roles-"));
  const configPath = pathJoin(dir, CONFIG_FILE_NAME);
  writeFileSync(
    configPath,
    JSON.stringify({
      roles: {
        imagegen: {
          label: "画像生成",
          emoji: "🎨",
          backend: "codex",
          appendSystemPrompt: "画像を作るエビ",
        },
      },
    }),
  );

  const raw = await loadRawCustomRoles(configPath);
  registerCustomRoles(raw);

  assert.equal(resolveRole("imagegen")?.label, "画像生成");
  assert.equal(resolveRole("imagegen")?.backend, "codex");
  assert.ok(availableRoleIds().includes("imagegen"));
  // 組込みは消えない。
  assert.ok(availableRoleIds().includes("engineer"));

  delete EBI_ROLES.imagegen;
});

test("未知の役割は『利用可能な役割名』を列挙したエラーで拒否される", () => {
  registerCustomRoles({ imagegen: { label: "画像生成" }, writer: { label: "執筆" } });

  const err = unknownRoleError("imagegenn");
  assert.match(err.message, /role が不正です: imagegenn/);
  // 一覧に組込み・カスタムの両方が出る（master が次に何を指定すべきか分かる）。
  for (const id of ["engineer", "imagegen", "writer"]) {
    assert.ok(err.message.includes(id), `${id} が一覧に無い: ${err.message}`);
  }

  delete EBI_ROLES.imagegen;
  delete EBI_ROLES.writer;
});

test("availableRoleIds は登録済み役割をそのまま返す（enum のスナップショットではない）", () => {
  const before = availableRoleIds();
  assert.ok(!before.includes("late-comer"));
  registerCustomRoles({ "late-comer": { label: "後から追加" } });
  assert.ok(availableRoleIds().includes("late-comer"));
  delete EBI_ROLES["late-comer"];
});
