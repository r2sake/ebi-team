// viewer の描き直し判定（src/client/viewer.ts の viewerNeedsRender）のテスト。
// registry / viewers を受けるたびに描き直して md が先頭へ戻っていた不具合の回帰防止。
//
// 実行: node --import tsx --test test/viewerRender.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { viewerNeedsRender } from "../src/client/viewer.ts";
import type { ViewerRecord } from "../src/shared/protocol.ts";

const rec = (over: Partial<ViewerRecord> = {}): ViewerRecord => ({
  id: "viewer-1",
  path: "/tmp/a.md",
  title: "a.md",
  format: "md",
  content: "# A\n\n本文",
  openedAt: 1000,
  ...over,
});

test("viewerNeedsRender: 中身が同じなら描き直さない（WS で届いた別オブジェクトでも）", () => {
  const a = rec();
  assert.equal(viewerNeedsRender(a, a), false);
  assert.equal(viewerNeedsRender(a, rec()), false);
  assert.equal(viewerNeedsRender(null, null), false);
});

test("viewerNeedsRender: 表示に出る欄のどれかが違えば描き直す", () => {
  const a = rec();
  assert.equal(viewerNeedsRender(a, rec({ content: "# A\n\n本文2" })), true);
  assert.equal(viewerNeedsRender(a, rec({ id: "viewer-2" })), true);
  assert.equal(viewerNeedsRender(a, rec({ openedAt: 2000 })), true);
  assert.equal(viewerNeedsRender(a, rec({ title: "B" })), true);
  assert.equal(viewerNeedsRender(a, rec({ path: "/tmp/b.md" })), true);
  assert.equal(viewerNeedsRender(a, rec({ format: "txt" })), true);
});

test("viewerNeedsRender: null との行き来は描き直す", () => {
  assert.equal(viewerNeedsRender(null, rec()), true);
  assert.equal(viewerNeedsRender(rec(), null), true);
});
