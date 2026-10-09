// ファイル編集機能（ボスが UI からファイル＝主に env を書き換える）のユニットテスト。
//
// 検証する中核:
//   - パス検証: フルパスのみ / `..` 拒否 / 許可ルート外拒否 / シンボリックリンクでの脱出拒否（既存・新規とも）
//   - 読み出し: 既存 / 新規（作るべきフォルダ）/ バイナリ・サイズ超過の拒否
//   - 保存: 開いたときの sha256 と現物が違えば保存しない / 控え（同じ権限）/ 原子的な置き換えで権限維持 /
//           新規は排他作成・秘密ファイルは 0600 / 親フォルダ作成はボスの確認が要る
//   - 書き込み記録に値が残らない
//   - master の依頼台帳: 受付時の検証・結果通知に値が入らない・見送り・無効な依頼
//   - 制御API /control/file-edit-request: 本文を受け取らず、chat master が居ないと 404
//   - env の鍵差し込み・伏せ字・行差分（UI 側の純関数）
//   - WS の Origin 判定（ブラウザの同一オリジンだけファイル編集を許す）
//   - チャットの依頼カードの畳み込み
//
// 実行: node --import tsx --test test/fileEditor.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileEditConflictError,
  FileEditError,
  FileEditor,
  FileEditRequests,
  backupStamp,
  defaultEditRoots,
  hashContent,
  isSecretPath,
  resolveEditTarget,
} from "../src/server/fileEditor.ts";
import { isSameOriginBrowser } from "../src/server/auth.ts";
import { createControlApi } from "../src/server/control.ts";
import { Registry } from "../src/server/registry.ts";
import {
  applyEnvValues,
  envKeysPresent,
  maskContent,
  maskLine,
  quoteEnvValue,
  MASK,
} from "../src/shared/envEdit.ts";
import { compactDiff, diffLines, diffStats } from "../src/shared/lineDiff.ts";
import { ChatTranscript, fileEditSettledLabel } from "../src/client/chatModel.ts";

async function makeEnv(): Promise<{ base: string; root: string; outside: string; cleanup: () => Promise<void> }> {
  // macOS の /var → /private/var を先に解決しておく（保存結果は実体パスで返るため）。
  const base = await realpath(await mkdtemp(join(tmpdir(), "ebi-file-edit-")));
  const root = join(base, "root");
  const outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { base, root, outside, cleanup: () => rm(base, { recursive: true, force: true }) };
}

// ===== パス検証 =====

test("相対パス・.. を含むパス・空は拒否する", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    await assert.rejects(resolveEditTarget("a/b.env", [root]), FileEditError);
    await assert.rejects(resolveEditTarget(`${root}/../root/x.env`, [root]), /「\.\.」/);
    await assert.rejects(resolveEditTarget("", [root]), FileEditError);
    await assert.rejects(resolveEditTarget(42, [root]), FileEditError);
    await assert.rejects(resolveEditTarget(`${root}/dir/`, [root]), FileEditError);
  } finally {
    await cleanup();
  }
});

test("許可ルート外は既存・新規とも拒否する", async () => {
  const { root, outside, cleanup } = await makeEnv();
  try {
    await writeFile(join(outside, "x.env"), "A=1\n");
    await assert.rejects(resolveEditTarget(join(outside, "x.env"), [root]), /許可ルートの外/);
    await assert.rejects(resolveEditTarget(join(outside, "new.env"), [root]), /許可ルートの外/);
    await assert.rejects(resolveEditTarget(join(outside, "deep", "new.env"), [root]), /許可ルートの外/);
  } finally {
    await cleanup();
  }
});

test("シンボリックリンクで許可ルートの外へ抜ける書き込みを拒否する（ファイル・フォルダとも）", async () => {
  const { root, outside, cleanup } = await makeEnv();
  try {
    await writeFile(join(outside, "secret.env"), "A=1\n");
    await symlink(join(outside, "secret.env"), join(root, "link.env"));
    await symlink(outside, join(root, "linkdir"));
    await assert.rejects(resolveEditTarget(join(root, "link.env"), [root]), /許可ルートの外/);
    // リンクしたフォルダ経由の新規作成・既存上書き。
    await assert.rejects(resolveEditTarget(join(root, "linkdir", "new.env"), [root]), /許可ルートの外/);
    await assert.rejects(resolveEditTarget(join(root, "linkdir", "a", "b.env"), [root]), /許可ルートの外/);
    await assert.rejects(resolveEditTarget(join(root, "linkdir", "secret.env"), [root]), /許可ルートの外/);
  } finally {
    await cleanup();
  }
});

test("許可ルート内を指すシンボリックリンクは実体のパスで扱う", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "a.env"), "A=1\n");
    await symlink(join(root, "real", "a.env"), join(root, "alias.env"));
    const t = await resolveEditTarget(join(root, "alias.env"), [root]);
    assert.equal(t.exists, true);
    assert.ok(t.realPath.endsWith(join("real", "a.env")));
  } finally {
    await cleanup();
  }
});

test("フォルダは編集対象にできない・無い親フォルダは浅い順に並ぶ", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    await mkdir(join(root, "dir"));
    await assert.rejects(resolveEditTarget(join(root, "dir"), [root]), /通常のファイルではありません/);
    const t = await resolveEditTarget(join(root, "a", "b", "c.env"), [root]);
    assert.equal(t.exists, false);
    assert.equal(t.missingDirs.length, 2);
    assert.ok(t.missingDirs[0]!.endsWith(join("root", "a")));
    assert.ok(t.missingDirs[1]!.endsWith(join("a", "b")));
  } finally {
    await cleanup();
  }
});

test("許可ルートの既定は ~/workspace と ~/.config・EBI_EDIT_ROOTS で上書きできる", () => {
  const def = defaultEditRoots({});
  assert.equal(def.length, 2);
  assert.ok(def[0]!.endsWith("/workspace"));
  assert.ok(def[1]!.endsWith("/.config"));
  assert.deepEqual(defaultEditRoots({ EBI_EDIT_ROOTS: "/tmp/a: /tmp/b " }), ["/tmp/a", "/tmp/b"]);
});

test("秘密を含みそうなファイル名を判定する", () => {
  for (const p of ["/x/.env", "/x/.env.local", "/x/prd.env", "/x/.dev.vars", "/x/api.key", "/x/credentials.json", "/x/cf-token.txt"]) {
    assert.equal(isSecretPath(p), true, p);
  }
  for (const p of ["/x/README.md", "/x/config.json", "/x/environment.md"]) {
    assert.equal(isSecretPath(p), false, p);
  }
});

// ===== 読み出し =====

test("load: 既存は本文と sha256、新規は content=null と作るべきフォルダを返す", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    await writeFile(join(root, "a.env"), "A=1\n");
    const editor = new FileEditor({ roots: [root] });
    const a = await editor.load(join(root, "a.env"));
    assert.equal(a.exists, true);
    assert.equal(a.content, "A=1\n");
    assert.equal(a.baseHash, hashContent("A=1\n"));
    assert.equal(a.secret, true);
    const n = await editor.load(join(root, "new", "b.txt"));
    assert.equal(n.exists, false);
    assert.equal(n.content, null);
    assert.equal(n.baseHash, null);
    assert.equal(n.missingDirs.length, 1);
  } finally {
    await cleanup();
  }
});

test("load: バイナリとサイズ超過は拒否する", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    await writeFile(join(root, "bin.dat"), Buffer.from([1, 0, 2]));
    await writeFile(join(root, "big.txt"), "x".repeat(100));
    const editor = new FileEditor({ roots: [root], maxBytes: 50 });
    await assert.rejects(editor.load(join(root, "bin.dat")), /テキストではない/);
    await assert.rejects(editor.load(join(root, "big.txt")), /大きすぎます/);
  } finally {
    await cleanup();
  }
});

// ===== 保存 =====

test("save: 上書きは控え（同じ権限）を残し、元の権限を保つ", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    const path = join(root, "prd.env");
    await writeFile(path, "A=1\n");
    await chmod(path, 0o600);
    const editor = new FileEditor({ roots: [root], now: () => new Date(2026, 9, 10, 9, 8, 7) });
    const loaded = await editor.load(path);
    const r = await editor.save({
      path,
      content: "A=2\n",
      baseHash: loaded.baseHash,
      createDirs: false,
      backup: true,
      actor: "boss-ui",
    });
    assert.equal(r.action, "update");
    assert.equal(r.backupPath, `${path}.bak-20261010-090807`);
    assert.equal(await readFile(path, "utf8"), "A=2\n");
    assert.equal(await readFile(r.backupPath!, "utf8"), "A=1\n");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(r.backupPath!)).mode & 0o777, 0o600);
    // 一時ファイルが残っていない。
    const names = await readdir(root);
    assert.deepEqual(names.sort(), ["prd.env", "prd.env.bak-20261010-090807"]);
    // 同じ秒にもう一度保存しても控えは上書きしない（-2 を付ける）。
    const again = await editor.save({
      path,
      content: "A=3\n",
      baseHash: hashContent("A=2\n"),
      createDirs: false,
      backup: true,
      actor: "boss-ui",
    });
    assert.equal(again.backupPath, `${path}.bak-20261010-090807-2`);
  } finally {
    await cleanup();
  }
});

test("save: 控えを残さない選択もできる", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    const path = join(root, "a.txt");
    await writeFile(path, "x\n");
    const editor = new FileEditor({ roots: [root] });
    const r = await editor.save({ path, content: "y\n", baseHash: hashContent("x\n"), createDirs: false, backup: false, actor: "boss-ui" });
    assert.equal(r.backupPath, null);
    assert.deepEqual(await readdir(root), ["a.txt"]);
  } finally {
    await cleanup();
  }
});

test("save: 開いた後に書き換わっていたら保存しない（上書き事故の防止）", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    const path = join(root, "a.env");
    await writeFile(path, "A=1\n");
    const editor = new FileEditor({ roots: [root] });
    const loaded = await editor.load(path);
    await writeFile(path, "A=other\n"); // 他所での変更
    await assert.rejects(
      editor.save({ path, content: "A=2\n", baseHash: loaded.baseHash, createDirs: false, backup: true, actor: "boss-ui" }),
      FileEditConflictError,
    );
    assert.equal(await readFile(path, "utf8"), "A=other\n");
    // 新規のつもりで開いたのに、間に作られていた。
    const p2 = join(root, "b.env");
    await writeFile(p2, "B=1\n");
    await assert.rejects(
      editor.save({ path: p2, content: "B=2\n", baseHash: null, createDirs: false, backup: false, actor: "boss-ui" }),
      FileEditConflictError,
    );
    // 既存のつもりで開いたのに、消えていた。
    await assert.rejects(
      editor.save({ path: join(root, "gone.env"), content: "x\n", baseHash: "abc", createDirs: false, backup: false, actor: "boss-ui" }),
      FileEditConflictError,
    );
  } finally {
    await cleanup();
  }
});

test("save: 新規作成は親フォルダの作成に確認が要り、秘密ファイルは 0600 で作る", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    const path = join(root, "app", "conf", "prd.env");
    const editor = new FileEditor({ roots: [root] });
    await assert.rejects(
      editor.save({ path, content: "A=1\n", baseHash: null, createDirs: false, backup: true, actor: "boss-ui" }),
      /親フォルダがありません/,
    );
    const r = await editor.save({ path, content: "A=1\n", baseHash: null, createDirs: true, backup: true, actor: "boss-ui" });
    assert.equal(r.action, "create");
    assert.equal(r.backupPath, null);
    assert.equal(r.createdDirs.length, 2);
    assert.equal(await readFile(path, "utf8"), "A=1\n");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "app"))).mode & 0o777, 0o700);
  } finally {
    await cleanup();
  }
});

test("save: 許可ルート外・不正な content・バイナリ・サイズ超過は書かない", async () => {
  const { root, outside, cleanup } = await makeEnv();
  try {
    const editor = new FileEditor({ roots: [root], maxBytes: 20 });
    await assert.rejects(
      editor.save({ path: join(outside, "x.env"), content: "A=1\n", baseHash: null, createDirs: true, backup: false, actor: "boss-ui" }),
      /許可ルートの外/,
    );
    await assert.rejects(
      editor.save({ path: join(root, "x.env"), content: 1, baseHash: null, createDirs: false, backup: false, actor: "boss-ui" }),
      /content/,
    );
    await assert.rejects(
      editor.save({ path: join(root, "x.env"), content: "a\0b", baseHash: null, createDirs: false, backup: false, actor: "boss-ui" }),
      /テキストではない/,
    );
    await assert.rejects(
      editor.save({ path: join(root, "x.env"), content: "x".repeat(21), baseHash: null, createDirs: false, backup: false, actor: "boss-ui" }),
      /大きすぎます/,
    );
    assert.deepEqual(await readdir(outside), []);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await cleanup();
  }
});

test("書き込み記録は いつ・どのファイル・誰 だけで、値を残さない", async () => {
  const { base, root, cleanup } = await makeEnv();
  try {
    const auditPath = join(base, "audit", "file-edits.jsonl");
    const editor = new FileEditor({ roots: [root], auditPath });
    const path = join(root, "prd.env");
    await editor.save({
      path,
      content: "CF_TOKEN=super-secret-value\n",
      baseHash: null,
      createDirs: false,
      backup: true,
      actor: "boss-ui:request:fedit-1",
      requestedBy: "master",
    });
    await editor.flush();
    const raw = await readFile(auditPath, "utf8");
    assert.ok(!raw.includes("super-secret-value"), "値が記録に入っている");
    const entry = JSON.parse(raw.trim()) as Record<string, unknown>;
    assert.equal(entry.action, "create");
    assert.ok(String(entry.path).endsWith("prd.env"));
    assert.equal(entry.actor, "boss-ui:request:fedit-1");
    assert.equal(entry.requestedBy, "master");
    assert.equal(typeof entry.ts, "string");
  } finally {
    await cleanup();
  }
});

test("控えの時刻はローカル時刻の YYYYMMDD-HHMMSS", () => {
  assert.equal(backupStamp(new Date(2026, 0, 2, 3, 4, 5)), "20260102-030405");
});

// ===== master の依頼台帳 =====

function makeRequests(root: string) {
  const events: { type: string; args: unknown[] }[] = [];
  const editor = new FileEditor({ roots: [root] });
  const reqs = new FileEditRequests(editor, {
    onRequest: (r) => events.push({ type: "request", args: [r] }),
    onSettled: (r, outcome, summary, notify) => events.push({ type: "settled", args: [r.id, outcome, summary, notify] }),
  });
  return { editor, reqs, events };
}

test("依頼: 許可ルート外・不正な鍵名は受け付けない", async () => {
  const { root, outside, cleanup } = await makeEnv();
  try {
    const { reqs, events } = makeRequests(root);
    await assert.rejects(reqs.create({ path: join(outside, "x.env") }), /許可ルートの外/);
    await assert.rejects(reqs.create({ path: join(root, "x.env"), keys: ["OK", "bad-key"] }), /鍵名が不正/);
    await assert.rejects(reqs.create({ path: join(root, "x.env"), keys: "A" }), /配列/);
    assert.equal(events.length, 0);
    assert.equal(reqs.size, 0);
  } finally {
    await cleanup();
  }
});

test("依頼: 保存の通知はパスと鍵名だけで、値を含まない", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    const { editor, reqs, events } = makeRequests(root);
    const path = join(root, "prd.env");
    const { request, exists } = await reqs.create({ path, keys: ["CF_TOKEN", "CF_TOKEN"], note: "CF のトークン", from: "master" });
    assert.equal(exists, false);
    assert.deepEqual(request.keys, ["CF_TOKEN"]);
    assert.equal(events[0]!.type, "request");
    const saved = await editor.save({ path, content: "CF_TOKEN=very-secret\n", baseHash: null, createDirs: false, backup: true, actor: "x" });
    reqs.markSaved(request.id, saved);
    const settled = events[1]!;
    assert.equal(settled.type, "settled");
    const [, outcome, summary, notify] = settled.args as [string, string, string, boolean];
    assert.equal(outcome, "saved");
    assert.equal(notify, true);
    assert.ok(summary.includes("CF_TOKEN"));
    assert.ok(!summary.includes("very-secret"));
    assert.equal(reqs.get(request.id), null);
  } finally {
    await cleanup();
  }
});

test("依頼: 見送りは master へ通知し、無効な依頼はカードを畳むだけ", async () => {
  const { root, cleanup } = await makeEnv();
  try {
    const { reqs, events } = makeRequests(root);
    const { request } = await reqs.create({ path: join(root, "a.env") });
    assert.equal(reqs.cancel(request.id), true);
    assert.deepEqual((events[1]!.args as unknown[]).slice(1, 2), ["cancelled"]);
    assert.equal((events[1]!.args as unknown[])[3], true);
    assert.equal(reqs.cancel(request.id), false);
    assert.deepEqual((events[2]!.args as unknown[]).slice(1), ["discarded", "依頼は既にありません", false]);
    reqs.forgetUnknown("fedit-zzz");
    assert.equal((events[3]!.args as unknown[])[1], "discarded");
    assert.equal((events[3]!.args as unknown[])[3], false);
  } finally {
    await cleanup();
  }
});

// ===== 制御API =====

async function postFileEditRequest(
  requestFileEdit: Parameters<typeof createControlApi>[0]["requestFileEdit"],
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const handle = createControlApi({
    registry: new Registry(),
    spawnAgent: async () => "ebi-1",
    inject: async () => ({ delivered: [], rejected: [], details: [] }),
    sendMessage: async () => ({ ok: false, error: "未使用", spawned: false }),
    broadcastRegistry: () => {},
    summarize: async () => ({ ok: false, reason: "未使用" }),
    ingestUsage: () => {},
    subscribe: async () => ({ messages: [] }),
    openViewer: async () => {
      throw new Error("未使用");
    },
    readViewerFile: async () => null,
    saveChatAttachment: null,
    readChatAttachment: null,
    shareChatImage: async () => null,
    requestChatPermission: null,
    requestFileEdit,
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    await handle(req, res, url.pathname, url.searchParams);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/control/file-edit-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("制御API: 依頼はパス・鍵名・メモだけを渡し、すぐ pending で返る", async () => {
  let got: Record<string, unknown> | null = null;
  const r = await postFileEditRequest(
    async (input) => {
      got = input as Record<string, unknown>;
      return { requestId: "fedit-1", path: "/x/prd.env", exists: false, keys: ["A"] };
    },
    { path: "/x/prd.env", keys: ["A"], note: "n", from: "master", content: "A=leak" },
  );
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "pending");
  assert.equal(r.json.requestId, "fedit-1");
  assert.deepEqual(Object.keys(got!).sort(), ["from", "keys", "note", "path"]);
});

test("制御API: chat master が居ないと 404・検証失敗は 400", async () => {
  const none = await postFileEditRequest(null, { path: "/x" });
  assert.equal(none.status, 404);
  const bad = await postFileEditRequest(async () => {
    throw new FileEditError("許可ルートの外には書けません: /x");
  }, { path: "/x" });
  assert.equal(bad.status, 400);
  assert.match(String(bad.json.error), /許可ルート/);
});

// ===== env の鍵差し込み・伏せ字 =====

test("applyEnvValues: 既存の鍵は右辺だけ置き換え、無い鍵は末尾に足す", () => {
  const src = "# comment\nexport A=1\nB = old\n\nC=keep\n";
  const out = applyEnvValues(src, { A: "x", B: "y", D: "z" });
  assert.equal(out, "# comment\nexport A=x\nB = y\n\nC=keep\nD=z\n");
  assert.equal(applyEnvValues("", { A: "1" }), "A=1\n");
  assert.equal(applyEnvValues("A=1", { B: "2" }), "A=1\nB=2\n");
  // コメントアウトされた鍵は置き換えず、新しく足す。
  assert.equal(applyEnvValues("# A=old\n", { A: "1" }), "# A=old\nA=1\n");
  assert.throws(() => applyEnvValues("", { "bad-key": "1" }), /鍵名/);
  assert.throws(() => applyEnvValues("", { A: "a\nb" }), /改行/);
});

test("quoteEnvValue: 安全な値は素のまま、それ以外は引用する", () => {
  assert.equal(quoteEnvValue("abc_DEF-123.x/y:z@w+="), "abc_DEF-123.x/y:z@w+=");
  assert.equal(quoteEnvValue("a b$c"), "'a b$c'");
  assert.equal(quoteEnvValue("it's $x"), '"it\'s \\$x"');
  assert.equal(quoteEnvValue(""), "");
});

test("伏せ字: 代入行は鍵名を残して値だけ伏せ、形式不明の行は丸ごと伏せる", () => {
  assert.equal(maskLine("A=secret"), `A=${MASK}`);
  assert.equal(maskLine("export B = 'x'"), `export B = ${MASK}`);
  assert.equal(maskLine("EMPTY="), "EMPTY=");
  assert.equal(maskLine("# comment"), "# comment");
  assert.equal(maskLine("-----BEGIN KEY-----"), MASK);
  assert.equal(maskContent("A=1\n\nB=2"), `A=${MASK}\n\nB=${MASK}`);
  assert.deepEqual([...envKeysPresent("A=1\n# B=2\nexport C=3\n")].sort(), ["A", "C"]);
});

// ===== 行差分 =====

test("diffLines / compactDiff: 変更行の前後だけを残す", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n") + "\n";
  const after = ["a", "b", "c", "D", "e", "f", "g", "h", "i"].join("\n") + "\n";
  const all = diffLines(before, after);
  assert.deepEqual(diffStats(all), { added: 2, removed: 1 });
  const compact = compactDiff(all, 1);
  assert.deepEqual(
    compact.map((l) => `${l.op}${l.text}`),
    ["…（変更なし 2 行）", " c", "-d", "+D", " e", "…（変更なし 2 行）", " h", "+i"],
  );
  assert.deepEqual(compactDiff(diffLines("x\n", "x\n")), []);
  assert.deepEqual(diffLines("", "a\n"), [{ op: "+", text: "a" }]);
});

// ===== WS の Origin 判定 =====

test("isSameOriginBrowser: Origin が Host と一致するときだけ true", () => {
  const h = (headers: Record<string, string>) => ({ headers });
  assert.equal(isSameOriginBrowser(h({ origin: "http://localhost:5173", host: "localhost:5173" })), true);
  assert.equal(isSameOriginBrowser(h({ origin: "http://100.64.0.1:8787", host: "100.64.0.1:8787" })), true);
  assert.equal(isSameOriginBrowser(h({ host: "127.0.0.1:8787" })), false); // Origin なし（素の WS クライアント）
  assert.equal(isSameOriginBrowser(h({ origin: "https://evil.example", host: "127.0.0.1:8787" })), false);
  assert.equal(isSameOriginBrowser(h({ origin: "null", host: "127.0.0.1:8787" })), false);
  assert.equal(isSameOriginBrowser(h({ origin: "file://x", host: "x" })), false);
});

// ===== チャットの依頼カード =====

test("チャット: 依頼カードは決着で畳まれ、値を持たない", () => {
  const t = new ChatTranscript();
  t.apply({
    seq: 1,
    ts: 1,
    event: { kind: "fileEditRequest", id: "fedit-1", path: "/x/prd.env", keys: ["A"], note: "n", from: "master" },
  });
  const item = t.items[0]!;
  assert.equal(item.kind, "fileEdit");
  assert.equal(item.kind === "fileEdit" && item.settled, null);
  const ch = t.apply({
    seq: 2,
    ts: 2,
    event: { kind: "fileEditSettled", id: "fedit-1", outcome: "saved", summary: "ボスが /x/prd.env を保存しました（鍵: A）" },
  });
  assert.deepEqual(ch.touched, [0]);
  assert.equal(item.kind === "fileEdit" && item.settled, "saved");
  assert.equal(fileEditSettledLabel("saved", "保存した"), "✅ 保存した");
  assert.equal(fileEditSettledLabel("cancelled", null), "⏭ 見送りました");
});
