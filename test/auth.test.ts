// アプリ層トークン認証（src/server/auth.ts）の純関数ユニットテスト。
//   - isLoopback: loopback アドレス判定（内部呼び・ローカル利用の無認証維持）
//   - authorize: 二段判定（loopback 素通り / 非loopback は token 必須 / 未設定は安全側拒否）
//   - extractToken / tokenMatches / parseCookie: トークン抽出と定数時間比較
//
// plan §7-2「WS の認証すり抜けを防ぐため専用テストを追加」に対応する。
// 実行: node --import tsx --test test/auth.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import {
  isLoopback,
  authorize,
  extractToken,
  tokenMatches,
  parseCookie,
  loadAuthConfig,
  type AuthConfig,
} from "../src/server/auth.ts";

/** テスト用の最小 IncomingMessage 相当を組み立てる。 */
function fakeReq(opts: {
  remoteAddress?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    socket: { remoteAddress: opts.remoteAddress } as never,
    headers: opts.headers ?? {},
  } as IncomingMessage;
}

const TOKEN: AuthConfig = { token: "s3cret-token" };
const NO_TOKEN: AuthConfig = { token: null };

// ===== isLoopback =====
test("isLoopback: IPv4 loopback → true", () => {
  assert.equal(isLoopback(fakeReq({ remoteAddress: "127.0.0.1" })), true);
});
test("isLoopback: IPv6 loopback → true", () => {
  assert.equal(isLoopback(fakeReq({ remoteAddress: "::1" })), true);
});
test("isLoopback: IPv4-mapped IPv6 loopback → true", () => {
  assert.equal(isLoopback(fakeReq({ remoteAddress: "::ffff:127.0.0.1" })), true);
});
test("isLoopback: LAN アドレス → false", () => {
  assert.equal(isLoopback(fakeReq({ remoteAddress: "192.168.1.140" })), false);
});
test("isLoopback: remoteAddress 不明 → false（安全側）", () => {
  assert.equal(isLoopback(fakeReq({})), false);
});

// ===== authorize（二段判定）=====
test("authorize: loopback は token 有無に関わらず常に許可", () => {
  assert.equal(authorize(fakeReq({ remoteAddress: "127.0.0.1" }), true, NO_TOKEN).ok, true);
  assert.equal(authorize(fakeReq({ remoteAddress: "127.0.0.1" }), true, TOKEN).ok, true);
});
test("authorize: 非loopback + token未設定 → 拒否（no-token-config・安全側デフォルト）", () => {
  const r = authorize(fakeReq({ remoteAddress: "192.168.1.140" }), false, NO_TOKEN);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "no-token-config");
});
test("authorize: 非loopback + 正しい Bearer → 許可", () => {
  const req = fakeReq({ remoteAddress: "10.0.0.5", headers: { authorization: "Bearer s3cret-token" } });
  assert.equal(authorize(req, false, TOKEN).ok, true);
});
test("authorize: 非loopback + 誤トークン → 拒否（invalid-token）", () => {
  const req = fakeReq({ remoteAddress: "10.0.0.5", headers: { authorization: "Bearer wrong" } });
  const r = authorize(req, false, TOKEN);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "invalid-token");
});
test("authorize: 非loopback + Cookie ebi_auth 正 → 許可", () => {
  const req = fakeReq({ remoteAddress: "10.0.0.5", headers: { cookie: "foo=bar; ebi_auth=s3cret-token" } });
  assert.equal(authorize(req, false, TOKEN).ok, true);
});
test("authorize: 非loopback + ?token= 正 → 許可（WS フォールバック経路）", () => {
  const req = fakeReq({ remoteAddress: "10.0.0.5" });
  const q = new URLSearchParams("token=s3cret-token");
  assert.equal(authorize(req, false, TOKEN, q).ok, true);
});
test("authorize: 非loopback + トークン無し → 拒否", () => {
  assert.equal(authorize(fakeReq({ remoteAddress: "10.0.0.5" }), false, TOKEN).ok, false);
});

// ===== extractToken の優先順位 =====
test("extractToken: Authorization Bearer を最優先", () => {
  const req = fakeReq({ headers: { authorization: "Bearer aaa", cookie: "ebi_auth=bbb" } });
  assert.equal(extractToken(req), "aaa");
});
test("extractToken: Bearer 無しなら Cookie", () => {
  assert.equal(extractToken(fakeReq({ headers: { cookie: "ebi_auth=bbb" } })), "bbb");
});
test("extractToken: いずれも無ければ query token", () => {
  const q = new URLSearchParams("token=ccc");
  assert.equal(extractToken(fakeReq({}), q), "ccc");
});
test("extractToken: 何も無ければ null", () => {
  assert.equal(extractToken(fakeReq({})), null);
});

// ===== tokenMatches（定数時間比較）=====
test("tokenMatches: 一致 → true", () => {
  assert.equal(tokenMatches("abc", "abc"), true);
});
test("tokenMatches: 不一致 → false", () => {
  assert.equal(tokenMatches("abc", "abd"), false);
});
test("tokenMatches: 長さ違い → false", () => {
  assert.equal(tokenMatches("ab", "abc"), false);
});
test("tokenMatches: expected 空 → false", () => {
  assert.equal(tokenMatches("abc", ""), false);
});

// ===== parseCookie =====
test("parseCookie: 該当名の値を取り出す", () => {
  assert.equal(parseCookie("a=1; ebi_auth=xyz; b=2", "ebi_auth"), "xyz");
});
test("parseCookie: 非該当 → null", () => {
  assert.equal(parseCookie("a=1; b=2", "ebi_auth"), null);
});
test("parseCookie: ヘッダ無し → null", () => {
  assert.equal(parseCookie(undefined, "ebi_auth"), null);
});

// ===== loadAuthConfig =====
test("loadAuthConfig: 未設定 → token null", () => {
  assert.equal(loadAuthConfig({} as NodeJS.ProcessEnv).token, null);
});
test("loadAuthConfig: 空白のみ → token null", () => {
  assert.equal(loadAuthConfig({ EBI_AUTH_TOKEN: "   " } as NodeJS.ProcessEnv).token, null);
});
test("loadAuthConfig: 値あり → trim して採用", () => {
  assert.equal(loadAuthConfig({ EBI_AUTH_TOKEN: " tok " } as NodeJS.ProcessEnv).token, "tok");
});
