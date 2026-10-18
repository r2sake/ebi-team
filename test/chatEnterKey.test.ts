// チャット入力欄の Enter の扱い（スマホは改行・PC は送信・IME 確定では送らない）のテスト。
//
// 実行: node --import tsx --test test/chatEnterKey.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { enterAction, inputPlaceholder } from "../src/client/chatModel.ts";

const base = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, composing: false };

test("PC: Enter は送信 / Shift+Enter は改行", () => {
  assert.equal(enterAction({ ...base, touch: false }), "send");
  assert.equal(enterAction({ ...base, shiftKey: true, touch: false }), "default");
});

test("タッチ端末: Enter も Shift+Enter も改行（送信はボタンだけ）", () => {
  assert.equal(enterAction({ ...base, touch: true }), "default");
  assert.equal(enterAction({ ...base, shiftKey: true, touch: true }), "default");
});

test("IME の変換確定の Enter では送信しない（PC・タッチ共通）", () => {
  for (const touch of [false, true]) {
    assert.equal(enterAction({ ...base, isComposing: true, touch }), "default");
    assert.equal(enterAction({ ...base, keyCode: 229, touch }), "default");
    assert.equal(enterAction({ ...base, composing: true, touch }), "default");
  }
});

test("Enter 以外のキーは何もしない", () => {
  assert.equal(enterAction({ ...base, key: "a", keyCode: 65, touch: false }), "default");
});

test("案内文: タッチ端末では Enter 送信の説明を出さない・短い", () => {
  assert.match(inputPlaceholder("idle", false), /Enter で送信/);
  assert.doesNotMatch(inputPlaceholder("idle", true), /Enter/);
  assert.doesNotMatch(inputPlaceholder("busy", true), /Enter/);
  assert.ok(inputPlaceholder("busy", true).length <= 14);
  assert.ok(inputPlaceholder("idle", true).length <= 14);
  assert.match(inputPlaceholder("stopped", true), /起動していません/);
});
