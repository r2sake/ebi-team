// md viewer の単体 + E2E（実課金なし）。tsx で実行して TS モジュールを直接 import する
// （package.json の e2e:viewer は `node --import tsx` で起動）。
//
// 単体:
//   U1. markdown レンダラ（parseMarkdown/parseInline）: 見出し/リスト/コード/表/インライン、
//       および XSS（md 中の <script> 等が text ノードとして扱われる＝実行されない）。
//   U2. パス検証（resolveViewerPath / ViewerRegistry）: 正常 open / 許可ルート外 /
//       拡張子違反 / サイズ超過 / シンボリックリンク脱出 / close。
//
// E2E（別ポート・EBI_COMMAND=bash・EBI_VIEWER_ROOTS=temp。稼働中 8787 に非干渉）:
//   E1. WS 接続直後に viewers（空）を受信。
//   E2. POST /control/open-viewer（正常）→ 200 + viewers broadcast に content 込みで反映＋自動追従用の新規判定。
//   E3. POST /control/open-viewer（許可ルート外 / 拡張子違反）→ 400。
//   E4. WS closeViewer → viewers broadcast が空へ戻る。
//
// 後始末（一時サーバ/temp dir）まで行う。

import { spawn } from "node:child_process";
import {
  writeFileSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { parseMarkdown, parseInline } from "../src/client/markdown.ts";
import {
  ViewerRegistry,
  resolveViewerPath,
  ViewerPathError,
} from "../src/server/viewerRegistry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const PORT = 8804;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const ok = (m) => { results.push(true); console.log("  OK:", m); };
const fail = (m) => { results.push(false); console.error("  NG:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- temp なファイル群 ----
const tmpDir = mkdtempSync(join(tmpdir(), "ebi-e2e-viewer-"));
const rootDir = join(tmpDir, "roots"); // 許可ルート
const outsideDir = join(tmpDir, "outside"); // 許可ルート外
mkdirSync(rootDir, { recursive: true });
mkdirSync(outsideDir, { recursive: true });
// macOS では /var → /private/var の symlink があるため、listDir が返す実体（realpath）基準の
// パスと比較できるよう、正規化済みルートを控えておく。
const realRootDir = realpathSync(rootDir);

const mdPath = join(rootDir, "plan.md");
const txtPath = join(rootDir, "note.txt");
const badExtPath = join(rootDir, "secret.env");
const bigPath = join(rootDir, "big.md");
const outsidePath = join(outsideDir, "secret.md");
const escapeLink = join(rootDir, "escape.md"); // outside への symlink

const SAMPLE_MD = [
  "# 見出し1",
  "",
  "本文に **bold** と *italic* と `inline` と [link](https://example.com) を含む。",
  "",
  "## 見出し2",
  "",
  "- 項目A",
  "- 項目B",
  "",
  "1. 番号1",
  "2. 番号2",
  "",
  "```js",
  "const x = 1; // <script>alert(1)</script> はコード内でも文字列",
  "```",
  "",
  "> 引用文です",
  "",
  "| 名前 | 値 |",
  "| --- | --- |",
  "| a | 1 |",
  "",
  "---",
  "",
  "生HTML: <script>alert('xss')</script> と <img src=x onerror=alert(1)>",
].join("\n");

writeFileSync(mdPath, SAMPLE_MD);
writeFileSync(txtPath, "plain text\n<script>not executed</script>\n");
writeFileSync(badExtPath, "SECRET=1");
writeFileSync(bigPath, "#".repeat(2000));
writeFileSync(outsidePath, "# outside secret");
symlinkSync(outsidePath, escapeLink);

function cleanup(code) {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

// ========== U1. markdown レンダラ ==========
function unitMarkdown() {
  console.log("\n--- U1. markdown レンダラ ---");
  const blocks = parseMarkdown(SAMPLE_MD);
  const types = blocks.map((b) => b.type);

  if (blocks.some((b) => b.type === "heading" && b.level === 1)) ok("h1 見出しを認識");
  else fail("h1 が無い: " + JSON.stringify(types));

  if (blocks.some((b) => b.type === "heading" && b.level === 2)) ok("h2 見出しを認識");
  else fail("h2 が無い");

  const lists = blocks.filter((b) => b.type === "list");
  if (lists.some((b) => !b.ordered) && lists.some((b) => b.ordered))
    ok("箇条書き + 番号リストを認識");
  else fail("リスト認識が不足: " + JSON.stringify(lists.map((l) => l.ordered)));

  const code = blocks.find((b) => b.type === "code");
  if (code && code.lang === "js" && code.value.includes("<script>"))
    ok("コードブロック（lang=js・中身は生文字列として保持）");
  else fail("コードブロックが不正: " + JSON.stringify(code));

  if (blocks.some((b) => b.type === "blockquote")) ok("引用を認識");
  else fail("引用が無い");

  const table = blocks.find((b) => b.type === "table");
  if (table && table.header.length === 2 && table.rows.length === 1)
    ok("表（ヘッダ2列・1行）を認識");
  else fail("表が不正: " + JSON.stringify(table));

  if (blocks.some((b) => b.type === "hr")) ok("水平線を認識");
  else fail("水平線が無い");

  // インライン: bold/italic/code/link。
  const inline = parseInline("**b** *i* `c` [t](https://e.com)");
  const kinds = inline.map((n) => n.type);
  if (["strong", "em", "code", "link"].every((k) => kinds.includes(k)))
    ok("インライン strong/em/code/link を認識");
  else fail("インライン認識が不足: " + JSON.stringify(kinds));
  const link = inline.find((n) => n.type === "link");
  if (link && link.href === "https://e.com" && link.text === "t") ok("リンク href/text 抽出");
  else fail("リンク抽出が不正: " + JSON.stringify(link));

  // XSS: 生 HTML タグは text ノードとして扱われる（strong/em/code/link 以外）。
  const para = blocks.find(
    (b) => b.type === "paragraph" && JSON.stringify(b.children).includes("script"),
  );
  const flat = para ? JSON.stringify(para.children) : "";
  const scriptAsText =
    para &&
    para.children.some(
      (n) => n.type === "text" && n.value.includes("<script>alert('xss')</script>"),
    );
  const noRawHtmlNode =
    !flat.includes('"html"') && !flat.includes('"raw"'); // そういうノード型は存在しない設計
  if (scriptAsText && noRawHtmlNode)
    ok("XSS 安全: 生 <script> は text ノード（実行対象にならない）");
  else fail("XSS: 生 HTML が text ノードになっていない: " + flat.slice(0, 200));
}

// ========== U2. パス検証 / ViewerRegistry ==========
async function unitPath() {
  console.log("\n--- U2. パス検証 / ViewerRegistry ---");
  const roots = [rootDir];
  const maxBytes = 1024;

  // 正常 .md
  try {
    const r = await resolveViewerPath(mdPath, roots, maxBytes * 100);
    if (r.format === "md") ok("正常 .md を解決（format=md）");
    else fail("format が md でない: " + r.format);
  } catch (e) {
    fail("正常 .md が弾かれた: " + e.message);
  }

  // 正常 .txt
  try {
    const r = await resolveViewerPath(txtPath, roots, maxBytes * 100);
    if (r.format === "txt") ok("正常 .txt を解決（format=txt）");
    else fail("format が txt でない: " + r.format);
  } catch (e) {
    fail("正常 .txt が弾かれた: " + e.message);
  }

  // 許可ルート外
  try {
    await resolveViewerPath(outsidePath, roots, maxBytes * 100);
    fail("許可ルート外が通ってしまった");
  } catch (e) {
    if (e instanceof ViewerPathError && /許可ルート外/.test(e.message)) ok("許可ルート外を拒否");
    else fail("許可ルート外の拒否理由が不正: " + e.message);
  }

  // シンボリックリンク脱出（root 内の symlink → outside 実体）
  try {
    await resolveViewerPath(escapeLink, roots, maxBytes * 100);
    fail("symlink 脱出が通ってしまった");
  } catch (e) {
    if (e instanceof ViewerPathError && /許可ルート外/.test(e.message)) ok("symlink 脱出を拒否（realpath 判定）");
    else fail("symlink 脱出の拒否理由が不正: " + e.message);
  }

  // 拡張子違反
  try {
    await resolveViewerPath(badExtPath, roots, maxBytes * 100);
    fail("拡張子違反が通ってしまった");
  } catch (e) {
    if (e instanceof ViewerPathError && /拡張子/.test(e.message)) ok("拡張子違反（.env）を拒否");
    else fail("拡張子違反の拒否理由が不正: " + e.message);
  }

  // サイズ超過
  try {
    await resolveViewerPath(bigPath, roots, 100); // big.md は 2000 バイト
    fail("サイズ超過が通ってしまった");
  } catch (e) {
    if (e instanceof ViewerPathError && /大きすぎ/.test(e.message)) ok("サイズ超過を拒否");
    else fail("サイズ超過の拒否理由が不正: " + e.message);
  }

  // 不存在
  try {
    await resolveViewerPath(join(rootDir, "nope.md"), roots, maxBytes * 100);
    fail("不存在ファイルが通ってしまった");
  } catch (e) {
    if (e instanceof ViewerPathError && /存在しません/.test(e.message)) ok("不存在ファイルを拒否");
    else fail("不存在の拒否理由が不正: " + e.message);
  }

  // ViewerRegistry open/close
  const reg = new ViewerRegistry({ roots, maxBytes: maxBytes * 100 });
  const rec = await reg.open({ path: mdPath, title: "計画" });
  if (rec.id.startsWith("viewer-") && rec.title === "計画" && rec.content.includes("# 見出し1"))
    ok(`ViewerRegistry.open（id=${rec.id}・content スナップショット込み）`);
  else fail("open の結果が不正: " + JSON.stringify({ id: rec.id, title: rec.title }));
  if (reg.list().length === 1) ok("list に 1 件");
  else fail("list 件数が不正");
  const rec2 = await reg.open({ path: txtPath }); // title 省略 → ファイル名
  if (rec2.title === "note.txt") ok("title 省略時はファイル名");
  else fail("title 省略時の既定が不正: " + rec2.title);
  if (reg.list().length === 2) ok("複数 viewer 同時 OK（2 件）");
  else fail("複数 viewer が保持されない");
  if (reg.close(rec.id) && reg.list().length === 1) ok("close で 1 件へ");
  else fail("close が効かない");
  if (!reg.close("viewer-999")) ok("存在しない id の close は false");
  else fail("存在しない id の close が true を返した");

  // ---- listDir（ファイルピッカー用のディレクトリ列挙）----
  const reg2 = new ViewerRegistry({ roots, maxBytes: maxBytes * 100 });

  // ルート一覧（path 省略）。
  const rootListing = await reg2.listDir();
  if (rootListing.atRoot && rootListing.up === null && rootListing.entries.some((e) => e.path === realRootDir && e.type === "dir"))
    ok("listDir(): ルート一覧（atRoot・up=null・ルートを dir として列挙）");
  else fail("listDir() ルート一覧が不正: " + JSON.stringify(rootListing));

  // rootDir 直下。plan.md/note.txt は eligible、secret.env は eligible=false、上へはルート一覧("")。
  const inside = await reg2.listDir(rootDir);
  const md = inside.entries.find((e) => e.name === "plan.md");
  const env = inside.entries.find((e) => e.name === "secret.env");
  if (!inside.atRoot && inside.up === "" && md?.eligible === true && env?.eligible === false)
    ok("listDir(root): 子を列挙（.md=eligible / .env=非eligible・up=ルート一覧）");
  else fail("listDir(root) が不正: " + JSON.stringify(inside));

  // 許可ルート外のディレクトリは拒否（存在有無を漏らさない汎用エラー）。
  try {
    await reg2.listDir(outsideDir);
    fail("listDir: 許可ルート外が通ってしまった");
  } catch (e) {
    if (e instanceof ViewerPathError && /許可ルート外/.test(e.message)) ok("listDir: 許可ルート外を拒否");
    else fail("listDir 許可ルート外の拒否理由が不正: " + e.message);
  }

  // ファイルを listDir すると「ディレクトリではない」。
  try {
    await reg2.listDir(mdPath);
    fail("listDir: ファイル指定が通ってしまった");
  } catch (e) {
    if (e instanceof ViewerPathError && /ディレクトリではありません/.test(e.message)) ok("listDir: ファイル指定を拒否");
    else fail("listDir ファイル指定の拒否理由が不正: " + e.message);
  }
}

// ========== E2E: 実サーバ ==========
let server;
let ws;
const received = []; // 受信した viewers メッセージ（配列）を順に格納
const dirListings = []; // 受信した dirListing メッセージを順に格納

function startServer() {
  server = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      EBI_PORT: String(PORT),
      EBI_COMMAND: "bash",
      EBI_DUMP_PATH: join(tmpDir, "registry.json"),
      EBI_VIEWER_ROOTS: rootDir,
      EBI_IDLE_NOTIFY: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
  server.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));
}

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function connectWs() {
  return new Promise((resolveWs, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "viewers") received.push(msg.viewers);
      if (msg.type === "dirListing") dirListings.push(msg);
    });
    ws.on("open", () => resolveWs());
    ws.on("error", reject);
  });
}

/** received の最後の viewers 配列が満たすまで待つ。 */
async function waitViewers(pred, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const last = received[received.length - 1];
    if (last !== undefined && pred(last)) return last;
    await sleep(100);
  }
  return null;
}

/** dirListings のうち述語を満たす最新メッセージが来るまで待つ。 */
async function waitDirListing(pred, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = [...dirListings].reverse().find(pred);
    if (hit) return hit;
    await sleep(100);
  }
  return null;
}

async function e2e() {
  console.log("\n--- E2E（実サーバ・別ポート）---");
  startServer();
  await sleep(2500);
  await connectWs();

  // E1. 接続直後に viewers（空）を受信。
  const initial = await waitViewers((v) => Array.isArray(v), 3000);
  if (initial && initial.length === 0) ok("E1: 接続直後に viewers（空）を受信");
  else fail("E1: 初期 viewers を受信できない: " + JSON.stringify(received));

  // E2. 正常 open → 200 + broadcast に content 込みで反映。
  const openRes = await postJson("/control/open-viewer", { path: mdPath, title: "計画v1" });
  if (openRes.status === 200 && openRes.body?.id?.startsWith("viewer-"))
    ok(`E2: open-viewer 200（id=${openRes.body.id}・応答に content 非同梱）`);
  else fail("E2: open-viewer が失敗: " + JSON.stringify(openRes));
  if (openRes.body && openRes.body.content === undefined) ok("E2: 応答に content を含めない（軽量）");
  else fail("E2: 応答に content が混じっている");

  const afterOpen = await waitViewers((v) => v.length === 1, 3000);
  if (
    afterOpen &&
    afterOpen[0].title === "計画v1" &&
    afterOpen[0].format === "md" &&
    afterOpen[0].content.includes("# 見出し1")
  )
    ok("E2: viewers broadcast に content スナップショット込みで反映");
  else fail("E2: broadcast 内容が不正: " + JSON.stringify(afterOpen));

  const openedId = openRes.body.id;

  // E3. 異常系 → 400。
  const outside = await postJson("/control/open-viewer", { path: outsidePath });
  if (outside.status === 400 && /許可ルート外/.test(outside.body?.error ?? ""))
    ok("E3: 許可ルート外 open は 400");
  else fail("E3: 許可ルート外が 400 でない: " + JSON.stringify(outside));

  const badExt = await postJson("/control/open-viewer", { path: badExtPath });
  if (badExt.status === 400 && /拡張子/.test(badExt.body?.error ?? ""))
    ok("E3: 拡張子違反 open は 400");
  else fail("E3: 拡張子違反が 400 でない: " + JSON.stringify(badExt));

  const noPath = await postJson("/control/open-viewer", {});
  if (noPath.status === 400) ok("E3: path 欠落は 400");
  else fail("E3: path 欠落が 400 でない: " + JSON.stringify(noPath));

  // E4. closeViewer（WS）→ viewers が空へ。
  ws.send(JSON.stringify({ type: "closeViewer", id: openedId }));
  const afterClose = await waitViewers((v) => v.length === 0, 3000);
  if (afterClose) ok("E4: closeViewer（WS）で viewers が空へ");
  else fail("E4: close 後に viewers が空にならない: " + JSON.stringify(received[received.length - 1]));

  // ---- ユーザー主導のファイルピッカー経路（WS listDir / openViewer）----

  // E5. listDir（ルート一覧）→ dirListing（atRoot・rootDir を含む）。
  ws.send(JSON.stringify({ type: "listDir" }));
  const rootLs = await waitDirListing((m) => m.listing?.atRoot === true, 3000);
  if (rootLs && rootLs.listing.entries.some((e) => e.path === realRootDir))
    ok("E5: listDir（省略）でルート一覧を受信（atRoot・rootDir 含む）");
  else fail("E5: ルート listDir が不正: " + JSON.stringify(rootLs));

  // E5b. listDir(rootDir) → plan.md が eligible、secret.env が非eligible。
  ws.send(JSON.stringify({ type: "listDir", path: rootDir }));
  const insideLs = await waitDirListing((m) => m.listing?.cwd === realRootDir, 3000);
  const e5md = insideLs?.listing.entries.find((e) => e.name === "plan.md");
  const e5env = insideLs?.listing.entries.find((e) => e.name === "secret.env");
  if (e5md?.eligible === true && e5env?.eligible === false)
    ok("E5b: listDir(root) で .md=eligible / .env=非eligible");
  else fail("E5b: listDir(root) が不正: " + JSON.stringify(insideLs));

  // E5c. 許可ルート外の listDir → error（存在有無を漏らさない）。
  ws.send(JSON.stringify({ type: "listDir", path: outsidePath }));
  const errLs = await waitDirListing((m) => typeof m.error === "string", 3000);
  if (errLs && /許可ルート外|アクセスできません/.test(errLs.error))
    ok("E5c: 許可ルート外の listDir は error（汎用理由）");
  else fail("E5c: 許可ルート外 listDir が error にならない: " + JSON.stringify(errLs));

  // E6. ユーザー openViewer（WS・正常）→ viewers broadcast に反映。
  ws.send(JSON.stringify({ type: "openViewer", path: txtPath, title: "ユーザーが開いた" }));
  const afterUserOpen = await waitViewers(
    (v) => v.some((x) => x.title === "ユーザーが開いた" && x.format === "txt"),
    3000,
  );
  if (afterUserOpen) ok("E6: ユーザー openViewer（WS）で viewers に反映");
  else fail("E6: ユーザー openViewer が反映されない: " + JSON.stringify(received[received.length - 1]));

  // E6b. ユーザー openViewer（許可ルート外）→ notice（id=viewer-open）で失敗、viewers は増えない。
  const beforeCount = (received[received.length - 1] ?? []).length;
  ws.send(JSON.stringify({ type: "openViewer", path: outsidePath }));
  await sleep(600);
  const nowCount = (received[received.length - 1] ?? []).length;
  if (nowCount === beforeCount) ok("E6b: 許可ルート外の openViewer は viewers を増やさない");
  else fail("E6b: 許可ルート外の openViewer が viewers を増やした: " + JSON.stringify(received[received.length - 1]));
}

async function finish() {
  try { ws?.close(); } catch {}
  try { server?.kill("SIGTERM"); } catch {}
  await sleep(500);
  const okCount = results.filter(Boolean).length;
  console.log(`\n==== md viewer 単体+E2E 結果: ${okCount}/${results.length} OK ====`);
  cleanup(okCount === results.length ? 0 : 1);
}

async function main() {
  unitMarkdown();
  await unitPath();
  await e2e();
  await finish();
}

const overall = setTimeout(() => { fail("全体タイムアウト"); finish(); }, 60000);
main()
  .then(() => clearTimeout(overall))
  .catch(async (e) => { fail("例外: " + (e?.stack ?? e)); await finish(); });
