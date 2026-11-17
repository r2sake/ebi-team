// 承認 / 質問の long-poll クライアント（src/mcp/longPoll.ts）のテスト。
//
// 実行: node --import tsx --test test/mcpLongPoll.test.ts
//
// 目的は「fetch の 300 秒（undici headersTimeout）で勝手に諦めない」こと。
// 5 分待つテストは回せないので、ここでは
//  - 遅れて返る応答をちゃんと拾う
//  - 非 2xx はエラーとして返す
//  - abort で接続を切る（サーバ側の保留破棄の合図になる）
// を確認する。300 秒側の実測は scripts の手動確認に任せる。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { postLongPoll } from "../src/mcp/longPoll.ts";

async function listen(
  handler: (body: string, res: import("node:http").ServerResponse) => void,
): Promise<{ url: string; server: Server; closed: Promise<void> }> {
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((r) => (markClosed = r));
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handler(Buffer.concat(chunks).toString("utf8"), res));
    res.on("close", () => {
      if (!res.writableEnded) markClosed();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}/control/chat-permission`, server, closed };
}

test("遅れて返る応答も取りこぼさず、body はそのまま届く", async () => {
  const s = await listen((body, res) => {
    const parsed = JSON.parse(body);
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ behavior: "allow", updatedInput: parsed.input }));
    }, 120);
  });
  const r = await postLongPoll(s.url, { tool_name: "Bash", input: { command: "ls" } })!;
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.data, { behavior: "allow", updatedInput: { command: "ls" } });
  s.server.close();
});

test("非 2xx は error として返す（黙って allow にしない）", async () => {
  const s = await listen((_body, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: '承認 UI は ui:"chat" の master が居るときだけ使えます' }));
  });
  const r = await postLongPoll(s.url, {})!;
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : "", /承認 UI は/);
  s.server.close();
});

test("abort で接続を切る（サーバ側は保留破棄の合図として受け取れる）", async () => {
  const s = await listen(() => {
    /* 応答を返さないまま握り続ける */
  });
  const ac = new AbortController();
  const p = postLongPoll(s.url, {}, ac.signal)!;
  setTimeout(() => ac.abort(), 50);
  const r = await p;
  assert.equal(r.ok, false);
  await s.closed; // サーバ側で close を観測できる
  s.server.close();
});

test("http 以外の URL は扱えないので null（呼び出し側が fetch へ落とす）", () => {
  assert.equal(postLongPoll("https://example.com/x", {}), null);
  assert.equal(postLongPoll("not a url", {}), null);
});
