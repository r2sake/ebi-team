// チャット添付の保管庫（PR-M4）のテスト。実ファイルは mkdtemp 配下にだけ作る。
//
// 実行: node --import tsx --test test/chatAttachments.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatAttachmentStore,
  MAX_TEXT_BYTES,
  isValidAttachmentName,
} from "../src/server/chatAttachments.ts";

function store(): { s: ChatAttachmentStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ebi-attach-"));
  return { s: new ChatAttachmentStore(dir), dir };
}

test("save: 絶対パス・basename・サムネイル URL を返し、read で引き直せる", async () => {
  const { s, dir } = store();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const saved = await s.save(png, "image/png", new Date(2026, 8, 5, 10, 11, 12));
    assert.match(saved.name, /^chat-20260905-101112-[0-9a-f]{8}\.png$/);
    assert.equal(saved.path, join(dir, saved.name));
    assert.equal(saved.mediaType, "image/png");
    assert.equal(saved.bytes, png.length);
    assert.equal(saved.url, `/control/chat-attachment?name=${saved.name}`);

    const read = await s.read(saved.name);
    assert.ok(read);
    assert.deepEqual(read.bytes, png);
    assert.equal(read.mediaType, "image/png");
    assert.equal(read.path, saved.path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save: 対応外 MIME・空・サイズ超過は拒否する", async () => {
  const { s, dir } = store();
  try {
    await assert.rejects(() => s.save(Buffer.from("x"), "application/x-sh"), /対応していない形式/);
    await assert.rejects(() => s.save(Buffer.alloc(0), "image/png"), /空のファイル/);
    await assert.rejects(
      () => s.save(Buffer.alloc(MAX_TEXT_BYTES + 1), "text/plain"),
      /大きすぎます/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read: 保管庫の形式に合わない name は一切受け付けない（パストラバーサル入口を作らない）", async () => {
  const { s, dir } = store();
  try {
    // 保管庫の外に実体を置いても、name の形式検証で届かない。
    writeFileSync(join(dir, "..", "outside.png"), "x");
    for (const bad of [
      "../outside.png",
      "/etc/passwd",
      "chat-20260905-101112-0a1b2c3d.png/../../etc/passwd",
      "evil.png",
      "chat-20260905-101112-XXXXXXXX.png",
      "chat-20260905-101112-0a1b2c3d.sh",
    ]) {
      assert.equal(isValidAttachmentName(bad), false, bad);
      assert.equal(await s.read(bad), null, bad);
    }
    // 形式は正しいが実体が無いものは null（例外にしない）。
    assert.equal(await s.read("chat-20260905-101112-0a1b2c3d.png"), null);
  } finally {
    rmSync(join(dir, "..", "outside.png"), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save: text/plain は .txt で保存される（大きな貼り付けのファイル誘導）", async () => {
  const { s, dir } = store();
  try {
    const saved = await s.save(Buffer.from("あ".repeat(9000)), "text/plain");
    assert.ok(saved.name.endsWith(".txt"));
    const read = await s.read(saved.name);
    assert.equal(read?.mediaType, "text/plain");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
