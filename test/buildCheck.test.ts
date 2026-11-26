import { test } from "node:test";
import assert from "node:assert/strict";
import { extractEntryAssets, isStaleBuild } from "../src/client/buildCheck.ts";

const html = (js: string, css: string) => `<!doctype html><html><head>
    <script type="module" crossorigin src="/assets/${js}"></script>
    <link rel="stylesheet" crossorigin href="/assets/${css}">
    <link rel="icon" href="/favicon.svg">
  </head><body></body></html>`;

test("extractEntryAssets: ビルド済み index.html から入口の js / css だけを取り出す", () => {
  assert.deepEqual(extractEntryAssets(html("index-CY665Y5s.js", "index-DeDwMEyS.css")), [
    "/assets/index-CY665Y5s.js",
    "/assets/index-DeDwMEyS.css",
  ]);
});

test("extractEntryAssets: dev（Vite の /main.ts 等）は対象外で空になる", () => {
  assert.deepEqual(extractEntryAssets(`<script type="module" src="/main.ts"></script><link rel="stylesheet" href="./style.css" />`), []);
});

test("isStaleBuild: 入口のハッシュが変われば古いタブと判定する", () => {
  const old = extractEntryAssets(html("index-B6FZWN3C.js", "index-CDX56SLU.css"));
  const cur = extractEntryAssets(html("index-CY665Y5s.js", "index-DeDwMEyS.css"));
  assert.equal(isStaleBuild(old, cur), true);
  assert.equal(isStaleBuild(cur, cur), false);
});

test("isStaleBuild: どちらかが空（dev・取得失敗）なら判定しない", () => {
  const cur = extractEntryAssets(html("index-CY665Y5s.js", "index-DeDwMEyS.css"));
  assert.equal(isStaleBuild([], cur), false);
  assert.equal(isStaleBuild(cur, []), false);
});
