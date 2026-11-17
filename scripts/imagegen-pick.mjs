// ボスが選んだ案を「透過用」フォルダにまとめて Finder で開く（master の側で動かす小物 CLI）。
//
//   npm run imagegen:pick -- --to <内容> <batch dir> <id...> [<batch dir> <id...> ...] [--suffix 採用] [--no-open]
//   例: npm run imagegen:pick -- --to vc-weapon-icons tmp/images/20261025-1239_vc-weapon-ring_r1 ring-1 \
//         tmp/images/20261025-1244_vc-weapon-orb_r1 orb_gem-2
//   → tmp/images/20261025_vc-weapon-icons_透過用/ に ring-1_magenta.png・ring-1_alpha.png… をコピーして開く
//
// id は「ファイル名の拡張子を除いた部分」が id そのもの、または id + "_" で始まるものに当たる
// （ring-1 → ring-1.png / ring-1_magenta.png / ring-1_alpha.png。ring-10 には当たらない）。
// 透過版（_alpha）がある案は透過版も一緒に入る。_rejected の版は入れない（ファイル名をそのまま書けば入る）。
// imagegen エビは codex のサンドボックス内で `open` できないので、この道具はエビには使わせない。

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const IMAGES = join(ROOT, "tmp", "images");
const EXTS = new Set([".png", ".webp", ".jpg", ".jpeg"]);

const usage = "使い方: npm run imagegen:pick -- --to <内容> <batch dir> <id...> [<batch dir> <id...> ...] [--suffix 採用] [--no-open]";

let to = null;
let suffix = "透過用";
let open = true;
const groups = []; // { dir, ids: [] }
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--to") to = args[++i];
  else if (a === "--suffix") suffix = args[++i];
  else if (a === "--no-open") open = false;
  else if (a === "-h" || a === "--help") {
    console.log(usage);
    process.exit(0);
  } else if (isDir(a)) groups.push({ dir: resolve(a), ids: [] });
  else if (groups.length === 0) fail(`先に batch dir を書くこと（ディレクトリが見つからない: ${a}）`);
  else groups.at(-1).ids.push(a);
}
if (!to) fail("--to <内容>（例: vc-weapon-icons）が必要です");
if (!/^[\p{L}\p{N}._-]+$/u.test(to) || !/^[\p{L}\p{N}._-]+$/u.test(suffix)) fail("--to と --suffix は英数・かな漢字・. _ - だけにすること");
if (groups.length === 0 || groups.some((g) => g.ids.length === 0)) fail("batch dir ごとに id を 1 つ以上書くこと");

const dest = join(IMAGES, `${today()}_${to}_${suffix}`);
mkdirSync(dest, { recursive: true });

const copied = [];
const missing = [];
for (const { dir, ids } of groups) {
  const files = readdirSync(dir).filter((f) => EXTS.has(extname(f).toLowerCase()) && !f.startsWith("contact"));
  for (const id of ids) {
    const stemId = EXTS.has(extname(id).toLowerCase()) ? id.slice(0, -extname(id).length) : id;
    const hits = files.filter((f) => {
      const stem = f.slice(0, -extname(f).length);
      // 不採用の版（_rejected）は、ファイル名をそのまま書いたときだけ入れる。
      if (stem === stemId) return true;
      return stem.startsWith(`${stemId}_`) && !stem.endsWith("_rejected");
    });
    if (hits.length === 0) {
      missing.push(`${basename(dir)}/${id}`);
      continue;
    }
    for (const f of hits) {
      const target = join(dest, f);
      if (existsSync(target)) console.log(`  上書き: ${f}`);
      copyFileSync(join(dir, f), target);
      copied.push(f);
    }
  }
}

console.log(`${dest}`);
for (const f of copied) console.log(`  + ${f}`);
if (missing.length > 0) console.error(`見つからない id: ${missing.join(", ")}`);

// 一覧（contact.png）も作っておく。失敗しても本体のコピーは済んでいるので警告だけ。
const contact = spawnSync("python3", [join(ROOT, "scripts", "imagegen-contact.py"), dest], { encoding: "utf8" });
if (contact.status === 0) console.log(`一覧: ${contact.stdout.trim()}`);
else console.error(`一覧を作れなかった: ${(contact.stderr || "").trim().split("\n").at(-1)}`);

if (open && process.platform === "darwin") spawnSync("open", [dest]);
process.exit(missing.length > 0 ? 1 : 0);

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function fail(msg) {
  console.error(msg);
  console.error(usage);
  process.exit(2);
}
