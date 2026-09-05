// master がチャットへ共有する画像（PR-M10・src/server/chatImages.ts）のユニットテスト。
//
// 検証する中核（＝新しい抜け道を作っていないこと）:
//   - 許可ルート外・シンボリックリンク脱出は拒否（open_viewer と同じ関門を通っている）
//   - 画像以外（.md/.txt）は拒否（拡張子 allow list に無いもの・あるが非画像の両方）
//   - サイズ超過は拒否（画像枠 maxImageBytes で判定される）
//   - 正常系は保管庫へ**コピー**され、name が保管庫の形式・url が name 参照・
//     sourcePath は元の絶対パス（配信には使わない表示用メタ）
//   - title / caption は空白だけなら null に潰れる
//
// 実行: node --import tsx --test test/chatImages.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shareChatImage } from "../src/server/chatImages.ts";
import { ChatAttachmentStore, isValidAttachmentName } from "../src/server/chatAttachments.ts";
import { ViewerPathError } from "../src/server/viewerRegistry.ts";

/** 最小の PNG バイト列（1x1 透明）。 */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

interface Env {
  base: string;
  /** 許可ルート。 */
  root: string;
  /** 許可ルートの外（脱出の検証用）。 */
  outside: string;
  store: ChatAttachmentStore;
  deps: Parameters<typeof shareChatImage>[2];
  cleanup: () => Promise<void>;
}

async function makeEnv(opts: { maxImageBytes?: number } = {}): Promise<Env> {
  const base = await mkdtemp(join(tmpdir(), "ebi-chat-image-"));
  const root = join(base, "workspace");
  const outside = join(base, "outside");
  const storeDir = join(base, "chat-attachments");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  const store = new ChatAttachmentStore(storeDir);
  return {
    base,
    root,
    outside,
    store,
    deps: {
      roots: [root],
      maxBytes: 1024 * 1024,
      maxImageBytes: opts.maxImageBytes ?? 8 * 1024 * 1024,
      save: (bytes, mediaType) => store.save(bytes, mediaType),
    },
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

async function writeFileAt(dir: string, name: string, bytes: Buffer | string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, bytes);
  return p;
}

test("正常系: 保管庫へコピーされ、name/url/sourcePath が揃う", async () => {
  const env = await makeEnv();
  try {
    const src = await writeFileAt(env.root, "shot.png", PNG_1PX);
    const image = await shareChatImage(src, { title: "エビ", caption: "生成サンプル" }, env.deps);

    assert.ok(isValidAttachmentName(image.name), `保管庫の名前形式であること: ${image.name}`);
    assert.equal(image.url, `/control/chat-attachment?name=${encodeURIComponent(image.name)}`);
    assert.equal(image.mediaType, "image/png");
    assert.equal(image.bytes, PNG_1PX.length);
    // sourcePath は元の絶対パス（表示用メタ）。配信キーは name だけ。
    assert.equal(image.sourcePath, src);
    assert.equal(image.title, "エビ");
    assert.equal(image.caption, "生成サンプル");

    // 実体が保管庫へコピーされている（元ファイルを消しても読める＝スナップショット意味論）。
    const copied = await env.store.read(image.name);
    assert.ok(copied, "保管庫から basename で引けること");
    assert.deepEqual(copied!.bytes, PNG_1PX);
    await rm(src);
    const stillThere = await env.store.read(image.name);
    assert.ok(stillThere, "元ファイルを消しても保管庫のコピーは残る");
  } finally {
    await env.cleanup();
  }
});

test("title / caption は未指定・空白だけなら null に潰れる", async () => {
  const env = await makeEnv();
  try {
    const src = await writeFileAt(env.root, "a.png", PNG_1PX);
    const bare = await shareChatImage(src, {}, env.deps);
    assert.equal(bare.title, null);
    assert.equal(bare.caption, null);
    const blank = await shareChatImage(src, { title: "  ", caption: "\n" }, env.deps);
    assert.equal(blank.title, null);
    assert.equal(blank.caption, null);
  } finally {
    await env.cleanup();
  }
});

test("拡張子: 画像 5 種は通り、.md/.txt は「画像ではない」として拒否される", async () => {
  const env = await makeEnv();
  try {
    for (const name of ["a.png", "b.jpg", "c.jpeg", "d.webp", "e.gif"]) {
      const p = await writeFileAt(env.root, name, PNG_1PX);
      const image = await shareChatImage(p, {}, env.deps);
      assert.match(image.mediaType, /^image\//, `${name} は画像として通るべき`);
    }
    for (const name of ["plan.md", "note.txt"]) {
      const p = await writeFileAt(env.root, name, "ただのテキスト");
      await assert.rejects(
        () => shareChatImage(p, {}, env.deps),
        (err: unknown) =>
          err instanceof ViewerPathError && /画像ファイルではありません/.test((err as Error).message),
        `${name} は拒否されるべき`,
      );
    }
  } finally {
    await env.cleanup();
  }
});

test("許可ルート外のパスは拒否される（保管庫にも何も残らない）", async () => {
  const env = await makeEnv();
  try {
    const outside = await writeFileAt(env.outside, "secret.png", PNG_1PX);
    await assert.rejects(
      () => shareChatImage(outside, {}, env.deps),
      (err: unknown) => err instanceof ViewerPathError && /許可ルート外/.test((err as Error).message),
    );
  } finally {
    await env.cleanup();
  }
});

test("シンボリックリンクで許可ルート外を指しても拒否される（realpath 基準）", async () => {
  const env = await makeEnv();
  try {
    const outside = await writeFileAt(env.outside, "secret.png", PNG_1PX);
    const link = join(env.root, "link.png");
    await symlink(outside, link);
    await assert.rejects(
      () => shareChatImage(link, {}, env.deps),
      (err: unknown) => err instanceof ViewerPathError && /許可ルート外/.test((err as Error).message),
    );
  } finally {
    await env.cleanup();
  }
});

test("サイズ上限（画像枠）を超えたら拒否される", async () => {
  const env = await makeEnv({ maxImageBytes: 64 });
  try {
    const big = await writeFileAt(env.root, "big.png", Buffer.alloc(200, 1));
    await assert.rejects(
      () => shareChatImage(big, {}, env.deps),
      (err: unknown) => err instanceof ViewerPathError && /大きすぎます/.test((err as Error).message),
    );
  } finally {
    await env.cleanup();
  }
});

test("存在しないパス・相対パス表記の親ディレクトリ脱出は拒否される", async () => {
  const env = await makeEnv();
  try {
    await assert.rejects(
      () => shareChatImage(join(env.root, "nope.png"), {}, env.deps),
      (err: unknown) => err instanceof ViewerPathError,
    );
    const outside = await writeFileAt(env.outside, "x.png", PNG_1PX);
    void outside;
    await assert.rejects(
      () => shareChatImage(join(env.root, "..", "outside", "x.png"), {}, env.deps),
      (err: unknown) => err instanceof ViewerPathError && /許可ルート外/.test((err as Error).message),
    );
  } finally {
    await env.cleanup();
  }
});

test("保管庫側の検証に落ちたときも ViewerPathError（＝ 400）へ寄せる", async () => {
  const env = await makeEnv();
  try {
    const src = await writeFileAt(env.root, "a.png", PNG_1PX);
    await assert.rejects(
      () =>
        shareChatImage(src, {}, {
          ...env.deps,
          save: async () => {
            throw new Error("ディスクがいっぱいです");
          },
        }),
      (err: unknown) =>
        err instanceof ViewerPathError && /保管庫へコピーできませんでした/.test((err as Error).message),
    );
  } finally {
    await env.cleanup();
  }
});

test("コピー後のバイト列は元ファイルと完全一致する（加工しない）", async () => {
  const env = await makeEnv();
  try {
    const bytes = Buffer.concat([PNG_1PX, Buffer.from("trailing-bytes")]);
    const src = await writeFileAt(env.root, "raw.png", bytes);
    const image = await shareChatImage(src, {}, env.deps);
    const copied = await readFile(join(env.store.directory, image.name));
    assert.deepEqual(copied, bytes);
  } finally {
    await env.cleanup();
  }
});
