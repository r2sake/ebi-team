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
  checkRequestOrigin,
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

// ===== checkRequestOrigin（CSWSH / CSRF 対策：別サイトのページからの WS・制御API を弾く）=====

function hdr(h: Record<string, string>): Pick<IncomingMessage, "headers"> {
  return { headers: h } as Pick<IncomingMessage, "headers">;
}

test("checkRequestOrigin: 同一オリジンのブラウザは通す（直・Vite proxy・Tailscale 経由）", () => {
  assert.deepEqual(checkRequestOrigin(hdr({ origin: "http://localhost:8787", host: "localhost:8787" })), { ok: true });
  assert.deepEqual(checkRequestOrigin(hdr({ origin: "http://localhost:5173", host: "localhost:5173" })), { ok: true });
  assert.deepEqual(checkRequestOrigin(hdr({ origin: "http://mac-mini:8787", host: "mac-mini:8787" })), { ok: true });
  assert.deepEqual(checkRequestOrigin(hdr({ origin: "http://100.64.0.1:8787", host: "100.64.0.1:8787" })), { ok: true });
  // 同一オリジンの GET（Origin なし・Sec-Fetch-Site: same-origin）や直打ち（none）も通す。
  assert.deepEqual(checkRequestOrigin(hdr({ host: "localhost:8787", "sec-fetch-site": "same-origin" })), { ok: true });
  assert.deepEqual(checkRequestOrigin(hdr({ host: "localhost:8787", "sec-fetch-site": "none" })), { ok: true });
});

test("checkRequestOrigin: 別サイトの Origin は弾く（別ドメイン・同ホスト別ポート・null）", () => {
  const bad = { ok: false, reason: "cross-origin" };
  assert.deepEqual(checkRequestOrigin(hdr({ origin: "https://evil.example", host: "127.0.0.1:8787" })), bad);
  assert.deepEqual(checkRequestOrigin(hdr({ origin: "http://localhost:3000", host: "localhost:8787" })), bad);
  assert.deepEqual(checkRequestOrigin(hdr({ origin: "http://127.0.0.1:8787", host: "localhost:8787" })), bad);
  assert.deepEqual(checkRequestOrigin(hdr({ origin: "null", host: "127.0.0.1:8787" })), bad);
  assert.deepEqual(checkRequestOrigin(hdr({ origin: "file://", host: "127.0.0.1:8787" })), bad);
  // Origin があれば Sec-Fetch-Site より Origin を優先する（same-origin を名乗っても Origin が違えば弾く）。
  assert.deepEqual(
    checkRequestOrigin(hdr({ origin: "https://evil.example", host: "127.0.0.1:8787", "sec-fetch-site": "same-origin" })),
    bad,
  );
});

test("checkRequestOrigin: Origin の無い別サイトの GET（<img src> 等）は Sec-Fetch-Site で弾く", () => {
  assert.deepEqual(
    checkRequestOrigin(hdr({ host: "127.0.0.1:8787", "sec-fetch-site": "cross-site" })),
    { ok: false, reason: "cross-site" },
  );
  // localhost の別ポートは same-site 扱いになるので、same-site も弾く。
  assert.deepEqual(
    checkRequestOrigin(hdr({ host: "localhost:8787", "sec-fetch-site": "same-site" })),
    { ok: false, reason: "cross-site" },
  );
});

test("checkRequestOrigin: Origin も Sec-Fetch-Site も無い Node のクライアントは通す（認証は authorize 側）", () => {
  assert.deepEqual(checkRequestOrigin(hdr({ host: "127.0.0.1:8787" })), { ok: true });
  // Node の fetch は sec-fetch-mode だけ付ける（Sec-Fetch-Site は付けない）。
  assert.deepEqual(checkRequestOrigin(hdr({ host: "127.0.0.1:8787", "sec-fetch-mode": "cors" })), { ok: true });
});
