// viewer の画像対応（.png/.jpg/.jpeg/.webp/.gif）のユニットテスト。
//
// 検証する中核:
//   - 拡張子判定: 画像拡張子は format="image" として通り、非対応拡張子は従来どおり弾かれる
//   - 許可範囲: 画像でも許可ルート外・シンボリックリンク脱出は拒否される（新しい抜け道を作らない）
//   - サイズ上限: 画像はテキストと別枠（maxImageBytes）で判定される
//   - open(): 画像は content を読まない（空文字）＝ WS broadcast にバイナリを載せない
//   - readImage(): 登録済み id のみバイト列＋Content-Type を返し、未登録/画像以外は null、
//     open 後にファイルが許可ルート外へ差し替わった場合は throw（配信時にも再検証する）
//   - md/txt の挙動は不変（content は従来どおり読まれる）
//
// 実行: node --import tsx --test test/viewerImage.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ViewerRegistry,
  ViewerPathError,
  imageMimeForPath,
  resolveViewerPath,
} from "../src/server/viewerRegistry.ts";

/** 最小の PNG バイト列（1x1 透明）。実ファイルとして書ければ十分なので中身は固定。 */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function makeEnv(): Promise<{ base: string; root: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "ebi-viewer-img-"));
  const root = join(base, "workspace");
  await mkdir(root, { recursive: true });
  return { base, root, cleanup: () => rm(base, { recursive: true, force: true }) };
}

async function writePng(dir: string, name: string, bytes: Buffer = PNG_1PX): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, bytes);
  return p;
}

// ===== 拡張子判定 =====

test("画像拡張子は format=image として解決される（大文字も可）", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    for (const name of ["a.png", "b.jpg", "c.jpeg", "d.webp", "e.gif", "f.PNG"]) {
      const p = await writePng(root, name);
      const r = await resolveViewerPath(p, [root], 1024, 1024);
      assert.equal(r.format, "image", `${name} は image になるべき`);
    }
  } finally {
    await cleanup();
  }
});

test("md/txt の拡張子判定は不変・非対応拡張子は従来どおり弾かれる", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    await writeFile(join(root, "a.md"), "# A", "utf8");
    await writeFile(join(root, "b.txt"), "B", "utf8");
    await writeFile(join(root, "c.svg"), "<svg/>", "utf8");
    assert.equal((await resolveViewerPath(join(root, "a.md"), [root], 1024, 1024)).format, "md");
    assert.equal((await resolveViewerPath(join(root, "b.txt"), [root], 1024, 1024)).format, "txt");
    // .svg はスクリプトを埋め込めるため画像として許可しない。
    await assert.rejects(
      () => resolveViewerPath(join(root, "c.svg"), [root], 1024, 1024),
      (err: Error) => err instanceof ViewerPathError && /対応していない拡張子/.test(err.message),
    );
  } finally {
    await cleanup();
  }
});

test("imageMimeForPath は拡張子から Content-Type を引く（画像以外は null）", () => {
  assert.equal(imageMimeForPath("/x/a.png"), "image/png");
  assert.equal(imageMimeForPath("/x/a.JPG"), "image/jpeg");
  assert.equal(imageMimeForPath("/x/a.jpeg"), "image/jpeg");
  assert.equal(imageMimeForPath("/x/a.webp"), "image/webp");
  assert.equal(imageMimeForPath("/x/a.gif"), "image/gif");
  assert.equal(imageMimeForPath("/x/a.md"), null);
  assert.equal(imageMimeForPath("/x/a.svg"), null);
});

// ===== 許可範囲 =====

test("画像でも許可ルート外は拒否される", async () => {
  const { base, root, cleanup } = await makeEnv();
  try {
    const outside = await writePng(base, "outside.png"); // root の外（base 直下）
    await assert.rejects(
      () => resolveViewerPath(outside, [root], 1024, 1024),
      (err: Error) => err instanceof ViewerPathError && /許可ルート外/.test(err.message),
    );
  } finally {
    await cleanup();
  }
});

test("画像でもシンボリックリンクによるルート脱出は拒否される", async () => {
  const { base, root, cleanup } = await makeEnv();
  try {
    const outside = await writePng(base, "secret.png");
    const link = join(root, "link.png");
    await symlink(outside, link);
    await assert.rejects(
      () => resolveViewerPath(link, [root], 1024, 1024),
      (err: Error) => err instanceof ViewerPathError && /許可ルート外/.test(err.message),
    );
  } finally {
    await cleanup();
  }
});

// ===== サイズ上限 =====

test("画像のサイズ上限はテキストと別枠（maxImageBytes）で判定される", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    const big = await writePng(root, "big.png", Buffer.alloc(4096, 1));
    // テキスト上限 100 バイトでも、画像上限 8192 なら通る。
    const ok = await resolveViewerPath(big, [root], 100, 8192);
    assert.equal(ok.format, "image");
    assert.equal(ok.size, 4096);
    // 画像上限を下回れば弾かれ、メッセージには画像側の上限が出る。
    await assert.rejects(
      () => resolveViewerPath(big, [root], 100, 1024),
      (err: Error) =>
        err instanceof ViewerPathError && /大きすぎます: 4096 バイト（上限 1024 バイト）/.test(err.message),
    );
  } finally {
    await cleanup();
  }
});

test("テキストの上限は従来どおり maxBytes で判定される（画像枠に引きずられない）", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    const p = join(root, "big.md");
    await writeFile(p, "x".repeat(2000), "utf8");
    await assert.rejects(
      () => resolveViewerPath(p, [root], 100, 8 * 1024 * 1024),
      (err: Error) =>
        err instanceof ViewerPathError && /大きすぎます: 2000 バイト（上限 100 バイト）/.test(err.message),
    );
  } finally {
    await cleanup();
  }
});

// ===== ViewerRegistry.open / readImage =====

test("open した画像は content を持たない（WS broadcast にバイナリを載せない）", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    const p = await writePng(root, "shot.png");
    const reg = new ViewerRegistry({ roots: [root], maxImageBytes: 8192 });
    const rec = await reg.open({ path: p });
    assert.equal(rec.format, "image");
    assert.equal(rec.content, "");
    assert.equal(rec.title, "shot.png");
    // md は従来どおり content を持つ（挙動不変）。
    await writeFile(join(root, "a.md"), "# A", "utf8");
    const md = await reg.open({ path: join(root, "a.md") });
    assert.equal(md.format, "md");
    assert.equal(md.content, "# A");
  } finally {
    await cleanup();
  }
});

test("readImage は登録済み id のバイト列と Content-Type を返す", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    const p = await writePng(root, "shot.png");
    const reg = new ViewerRegistry({ roots: [root], maxImageBytes: 8192 });
    const rec = await reg.open({ path: p });
    const file = await reg.readImage(rec.id);
    assert.ok(file);
    assert.equal(file.mime, "image/png");
    assert.deepEqual(file.bytes, PNG_1PX);
    assert.equal(file.path, p);
  } finally {
    await cleanup();
  }
});

test("readImage は未登録 id と画像以外の viewer には null を返す", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    await writeFile(join(root, "a.md"), "# A", "utf8");
    const reg = new ViewerRegistry({ roots: [root] });
    const md = await reg.open({ path: join(root, "a.md") });
    assert.equal(await reg.readImage("viewer-999"), null);
    assert.equal(await reg.readImage(md.id), null);
  } finally {
    await cleanup();
  }
});

test("readImage は配信時にも再検証する（open 後に許可ルート外へ差し替わったら拒否）", async () => {
  const { base, root, cleanup } = await makeEnv();
  try {
    const p = await writePng(root, "shot.png");
    const reg = new ViewerRegistry({ roots: [root], maxImageBytes: 8192 });
    const rec = await reg.open({ path: p });

    // open 後に実体をルート外へ向けた symlink へ差し替える。
    const outside = await writePng(base, "secret.png");
    await unlink(p);
    await symlink(outside, p);

    await assert.rejects(
      () => reg.readImage(rec.id),
      (err: Error) => err instanceof ViewerPathError && /許可ルート外/.test(err.message),
    );

    // ファイルごと消えた場合も throw（壊れた配信をしない）。
    await unlink(p);
    await assert.rejects(
      () => reg.readImage(rec.id),
      (err: Error) => err instanceof ViewerPathError && /存在しません/.test(err.message),
    );
  } finally {
    await cleanup();
  }
});

test("ファイルピッカーの eligible に画像が含まれる（md/txt はそのまま）", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    await writePng(root, "shot.png");
    await writeFile(join(root, "a.md"), "# A", "utf8");
    await writeFile(join(root, "b.bin"), "x", "utf8");
    const reg = new ViewerRegistry({ roots: [root] });
    const listing = await reg.listDir(root);
    const byName = new Map(listing.entries.map((e) => [e.name, e]));
    assert.equal(byName.get("shot.png")?.eligible, true);
    assert.equal(byName.get("a.md")?.eligible, true);
    assert.equal(byName.get("b.bin")?.eligible, false);
  } finally {
    await cleanup();
  }
});

test("画像 viewer も再起動をまたいで復元される（content は空のまま）", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    const storePath = join(root, "..", ".ebi-team", "viewers.json");
    const p = await writePng(root, "shot.png");
    const reg = new ViewerRegistry({ roots: [root], maxImageBytes: 8192, storePath });
    const rec = await reg.open({ path: p, title: "生成画像" });
    await reg.flush();

    const reg2 = new ViewerRegistry({ roots: [root], maxImageBytes: 8192, storePath });
    const restored = await reg2.restore();
    assert.equal(restored.restored.length, 1);
    assert.equal(restored.restored[0].id, rec.id);
    assert.equal(restored.restored[0].format, "image");
    assert.equal(restored.restored[0].content, "");
    // 復元後も readImage でバイト列を配信できる。
    const file = await reg2.readImage(rec.id);
    assert.deepEqual(file?.bytes, PNG_1PX);
  } finally {
    await cleanup();
  }
});
