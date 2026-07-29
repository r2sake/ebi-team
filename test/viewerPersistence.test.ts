// ViewerRegistry の永続化（viewers.json）のユニットテスト。
//
// 検証する中核:
//   - open で viewers.json に {id, path, title, openedAt} が保存される
//   - 新インスタンスの restore() で同じ id/title/openedAt のまま復元される（= 再起動後のタブ復元）
//   - close で該当エントリが viewers.json から消える
//   - 復元時にファイルが消えている / 許可ルート外のエントリは skip され、viewers.json から掃除される
//   - 書き込みは atomic（tmp → rename。tmp を残さない・壊れた JSON を読ませない）
//   - 壊れた viewers.json でも restore は throw せず起動を止めない
//
// 実行: node --import tsx --test test/viewerPersistence.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ViewerRegistry } from "../src/server/viewerRegistry.ts";

/** テスト用の一時 root（許可ルート）と store パスを用意する。 */
async function makeEnv(): Promise<{ root: string; storePath: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "ebi-viewer-"));
  const root = join(base, "workspace");
  await mkdir(root, { recursive: true });
  const storePath = join(base, ".ebi-team", "viewers.json");
  return { root, storePath, cleanup: () => rm(base, { recursive: true, force: true }) };
}

async function writeMd(root: string, name: string, body: string): Promise<string> {
  const p = join(root, name);
  await writeFile(p, body, "utf8");
  return p;
}

async function readStore(storePath: string): Promise<{ version: number; viewers: any[] }> {
  return JSON.parse(await readFile(storePath, "utf8"));
}

test("open すると viewers.json に {id, path, title, openedAt} が保存される", async () => {
  const { root, storePath, cleanup } = await makeEnv();
  try {
    const p = await writeMd(root, "a.md", "# hello");
    const reg = new ViewerRegistry({ roots: [root], storePath });
    const rec = await reg.open({ path: p, title: "メモA" });
    await reg.flush();

    const store = await readStore(storePath);
    assert.equal(store.version, 1);
    assert.equal(store.viewers.length, 1);
    assert.equal(store.viewers[0].id, rec.id);
    assert.equal(store.viewers[0].title, "メモA");
    assert.equal(store.viewers[0].path, rec.path);
    assert.ok(typeof store.viewers[0].openedAt === "number" && store.viewers[0].openedAt > 0);
    // content は保存しない（復元時にファイルから読み直す）。
    assert.equal(store.viewers[0].content, undefined);
  } finally {
    await cleanup();
  }
});

test("新インスタンスの restore() で同じ id/title/openedAt のまま復元される", async () => {
  const { root, storePath, cleanup } = await makeEnv();
  try {
    const p1 = await writeMd(root, "a.md", "# A");
    const p2 = await writeMd(root, "b.txt", "plain B");
    const reg = new ViewerRegistry({ roots: [root], storePath });
    const r1 = await reg.open({ path: p1, title: "メモA" });
    const r2 = await reg.open({ path: p2 });
    await reg.flush();

    // サーバ再起動相当。
    const reg2 = new ViewerRegistry({ roots: [root], storePath });
    const res = await reg2.restore();
    assert.equal(res.skipped.length, 0);
    assert.equal(res.restored.length, 2);

    const list = reg2.list();
    assert.deepEqual(list.map((v) => v.id), [r1.id, r2.id]);
    assert.deepEqual(list.map((v) => v.title), ["メモA", "b.txt"]);
    assert.deepEqual(list.map((v) => v.openedAt), [r1.openedAt, r2.openedAt]);
    // content と format は復元時にファイルから読み直される。
    assert.equal(list[0].content, "# A");
    assert.equal(list[0].format, "md");
    assert.equal(list[1].content, "plain B");
    assert.equal(list[1].format, "txt");

    // 復元後に新規 open しても id が衝突しない（採番が続きから）。
    const p3 = await writeMd(root, "c.md", "# C");
    const r3 = await reg2.open({ path: p3 });
    assert.ok(!new Set([r1.id, r2.id]).has(r3.id));
  } finally {
    await cleanup();
  }
});

test("close すると viewers.json から該当エントリが消える", async () => {
  const { root, storePath, cleanup } = await makeEnv();
  try {
    const p1 = await writeMd(root, "a.md", "# A");
    const p2 = await writeMd(root, "b.md", "# B");
    const reg = new ViewerRegistry({ roots: [root], storePath });
    const r1 = await reg.open({ path: p1 });
    const r2 = await reg.open({ path: p2 });

    assert.equal(reg.close(r1.id), true);
    await reg.flush();
    const store = await readStore(storePath);
    assert.deepEqual(store.viewers.map((v: any) => v.id), [r2.id]);

    // 存在しない id の close は書き込みも起こさない（false を返すだけ）。
    assert.equal(reg.close("viewer-999"), false);
    await reg.flush();

    const reg2 = new ViewerRegistry({ roots: [root], storePath });
    await reg2.restore();
    assert.deepEqual(reg2.list().map((v) => v.id), [r2.id]);
  } finally {
    await cleanup();
  }
});

test("復元時にファイルが消えているエントリは skip され viewers.json から掃除される", async () => {
  const { root, storePath, cleanup } = await makeEnv();
  try {
    const p1 = await writeMd(root, "a.md", "# A");
    const p2 = await writeMd(root, "gone.md", "# GONE");
    const reg = new ViewerRegistry({ roots: [root], storePath });
    const r1 = await reg.open({ path: p1 });
    await reg.open({ path: p2 });
    await reg.flush();

    await rm(p2); // 再起動前にファイルが消えた状況。

    const reg2 = new ViewerRegistry({ roots: [root], storePath });
    const res = await reg2.restore();
    assert.equal(res.restored.length, 1);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].path, p2);
    assert.deepEqual(reg2.list().map((v) => v.id), [r1.id]);

    await reg2.flush();
    const store = await readStore(storePath);
    assert.deepEqual(store.viewers.map((v: any) => v.id), [r1.id]);
  } finally {
    await cleanup();
  }
});

test("許可ルート外になったエントリは skip される（root 変更・fail-soft）", async () => {
  const { root, storePath, cleanup } = await makeEnv();
  try {
    const p = await writeMd(root, "a.md", "# A");
    const reg = new ViewerRegistry({ roots: [root], storePath });
    await reg.open({ path: p });
    await reg.flush();

    // 許可ルートが変わった（EBI_VIEWER_ROOTS 変更相当）。
    const otherRoot = join(root, "sub");
    await mkdir(otherRoot, { recursive: true });
    const reg2 = new ViewerRegistry({ roots: [otherRoot], storePath });
    const res = await reg2.restore();
    assert.equal(res.restored.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.match(res.skipped[0].reason, /許可ルート外/);
    assert.deepEqual(reg2.list(), []);
  } finally {
    await cleanup();
  }
});

test("壊れた viewers.json でも restore は throw せず空で継続する", async () => {
  const { root, storePath, cleanup } = await makeEnv();
  try {
    await mkdir(join(storePath, ".."), { recursive: true });
    await writeFile(storePath, "{ this is not json", "utf8");
    const reg = new ViewerRegistry({ roots: [root], storePath });
    const res = await reg.restore();
    assert.deepEqual(res.restored, []);
    assert.deepEqual(res.skipped, []);
    assert.deepEqual(reg.list(), []);
  } finally {
    await cleanup();
  }
});

test("書き込みは atomic（tmp を残さず・常に完全な JSON が読める）", async () => {
  const { root, storePath, cleanup } = await makeEnv();
  try {
    const files = await Promise.all(
      [...Array(5)].map((_, i) => writeMd(root, `f${i}.md`, `# ${i}`)),
    );
    const reg = new ViewerRegistry({ roots: [root], storePath });
    // 連続 open（永続化はチェーンで直列化される）。
    const recs = [];
    for (const f of files) recs.push(await reg.open({ path: f }));
    await reg.flush();

    // tmp ファイルが残っていないこと。
    const dirFiles = await readdir(join(storePath, ".."));
    assert.deepEqual(dirFiles.filter((f) => f.includes(".tmp-")), []);
    assert.deepEqual(dirFiles, ["viewers.json"]);

    // 中身は完全な JSON で全件揃っている。
    const store = await readStore(storePath);
    assert.deepEqual(store.viewers.map((v: any) => v.id), recs.map((r) => r.id));
  } finally {
    await cleanup();
  }
});

test("storePath 未指定なら永続化しない（従来どおりメモリのみ）", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    const p = await writeMd(root, "a.md", "# A");
    const reg = new ViewerRegistry({ roots: [root] });
    const rec = await reg.open({ path: p });
    await reg.flush();
    assert.equal(reg.list().length, 1);
    assert.equal(reg.close(rec.id), true);
    // restore は何もせず空を返す。
    assert.deepEqual((await reg.restore()).restored, []);
  } finally {
    await cleanup();
  }
});
