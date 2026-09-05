// 画像生成 PoC 第2弾（2026-09-05・ChatGPT Plus 化後）の使い捨てドライバ。
//
// codex エビを spawn → 画像生成 → PNG 保存 → reply_to_master 着弾 →
// master 側の open_viewer 相当（POST /control/open-viewer）→ GET /control/viewer-file で
// PNG バイト列が配信されるところまでを一気通貫で検証する。
//
// 安全策: 稼働サーバ（8787）には一切触らない。専用ポート（既定 8812）で control-server を
// 自前起動し、mkdtemp した状態ディレクトリで完結する。master は bash の使い捨てエビ。
//
//   node scripts/poc-imagegen-plus.mjs

import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PORT = Number(process.env.EBI_POC_PORT ?? 8812);
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = Number(process.env.EBI_POC_TIMEOUT_MS ?? 420000);
const OUT_REL = "docs/poc/imagegen-plus-ebi.png";
const OUT_ABS = join(ROOT, OUT_REL);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) =>
  s.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b[()][A-Z0-9]/g, "");

const api = {
  async get(p) { const r = await fetch(`${BASE}${p}`); return { status: r.status, body: await r.json().catch(() => null) }; },
  async post(p, b) {
    const r = await fetch(`${BASE}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b ?? {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  },
  async scrollback(id) { return stripAnsi((await this.get(`/control/scrollback?id=${encodeURIComponent(id)}`)).body?.data ?? ""); },
};

function writeConfig(dir) {
  const p = join(dir, "config.poc.json");
  writeFileSync(p, JSON.stringify({
    fixedEbi: [{ id: "master", kind: "master", cwd: ROOT, command: "bash", args: ["-c", "echo MASTER_UP; exec cat"], notifySubscribe: false }],
    roles: {
      imagegen: {
        label: "画像生成係", emoji: "🎨",
        permissionMode: "acceptEdits", // codex では -s workspace-write に写像される
        appendSystemPrompt:
          "あなたは画像生成係。画像は必ず組み込みの image_gen（image_gen__imagegen）ツールで生成し、" +
          "指定されたパスに PNG として保存すること。作業結果の報告は必ず reply_to_master ツールで送ること" +
          "（チャットに書くだけでは master に届かない）。",
      },
    },
  }, null, 2) + "\n");
  return p;
}

function startServer(tmpDir, configPath) {
  const proc = spawn("node", ["dist/server/server/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      EBI_PORT: String(PORT), EBI_HOST: "127.0.0.1", EBI_DEFAULT_CWD: ROOT,
      EBI_DUMP_PATH: join(tmpDir, "registry.json"), EBI_CONFIG_PATH: configPath,
      EBI_VIEWERS_PATH: join(tmpDir, "viewers.json"),
      EBI_DELIVERY_LOG_PATH: join(tmpDir, "delivery.log"), EBI_FIXED_EBI_LOG_PATH: join(tmpDir, "fixed-ebi.log"),
      EBI_READY_WAIT_MS: "120000", EBI_SUBSCRIBE_WAIT_MS: "5000", EBI_IDLE_NOTIFY: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  return proc;
}

async function waitForServer(ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    try { if ((await api.get("/control/agents")).status === 200) return true; } catch { /* not listening yet */ }
    if (Date.now() - t0 > ms) return false;
    await sleep(500);
  }
}

const TASK =
  "[poc-imagegen-plus] 組み込みの image_gen（image_gen__imagegen）ツールで画像を 1 枚生成し、" +
  `このリポジトリの ${OUT_REL} に PNG として保存してください。` +
  "題材: 白背景に、エビのマスコットがノートPCを持っているシンプルでかわいいフラットなアイコン。1024x1024 程度。" +
  "保存できたら reply_to_master ツールで『生成できた／ファイルパス／使ったツール名』を 1 回だけ報告してください。" +
  "生成できなかった場合も、何を試して何と言われたかを 3 行以内で reply_to_master に報告してください。";

async function main() {
  const t0all = Date.now();
  if (existsSync(OUT_ABS)) rmSync(OUT_ABS);
  const tmpDir = mkdtempSync(join(tmpdir(), "ebi-poc-imagegen-plus-"));
  const srv = startServer(tmpDir, writeConfig(tmpDir));
  console.log(`[poc] server pid=${srv.pid} port=${PORT} tmp=${tmpDir}`);
  if (!await waitForServer()) { console.error("[poc] server 起動失敗"); srv.kill("SIGTERM"); process.exit(1); }

  const tSpawn = Date.now();
  const sp = await api.post("/control/spawn", { role: "imagegen", backend: "codex", cwd: ROOT });
  console.log("[poc] spawn:", sp.status, JSON.stringify(sp.body));
  const id = sp.body?.id;
  if (!id) { srv.kill("SIGTERM"); process.exit(1); }
  console.log(`[poc] spawn 所要 ${((Date.now() - tSpawn) / 1000).toFixed(1)}s`);

  const tSend = Date.now();
  const snd = await api.post("/control/send", { to: id, from: "master", message: TASK });
  console.log("[poc] send:", snd.status, JSON.stringify(snd.body));

  let masterTxt = "";
  let replied = false;
  for (;;) {
    masterTxt = await api.scrollback("master");
    if (/\[reply\]/.test(masterTxt)) { replied = true; break; }
    if (Date.now() - tSend > TIMEOUT_MS) { console.log("[poc] タイムアウト"); break; }
    await sleep(5000);
  }
  const genSec = ((Date.now() - tSend) / 1000).toFixed(1);
  console.log(`[poc] reply 着弾=${replied} 生成所要 ${genSec}s`);
  console.log("=== master scrollback (tail) ===\n" + masterTxt.slice(-2000));

  const ebiTxt = await api.scrollback(id);
  writeFileSync(join(ROOT, "tmp/imagegen-plus/ebi-screen.txt"), ebiTxt);

  // ---- 生成物の検証 ----
  const ok = existsSync(OUT_ABS);
  console.log(`[poc] PNG 存在=${ok}` + (ok ? ` size=${statSync(OUT_ABS).size}` : ""));

  // ---- open_viewer（master 専用 MCP のブリッジ）→ viewer-file 配信 ----
  let viewerResult = null;
  if (ok) {
    const ov = await api.post("/control/open-viewer", { path: OUT_ABS, title: "imagegen-plus-ebi" });
    console.log("[poc] open-viewer:", ov.status, JSON.stringify(ov.body));
    const vid = ov.body?.id;
    if (vid) {
      const r = await fetch(`${BASE}/control/viewer-file?id=${encodeURIComponent(vid)}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      viewerResult = {
        status: r.status, contentType: r.headers.get("content-type"),
        length: buf.length, pngMagic: isPng,
        nosniff: r.headers.get("x-content-type-options"), cacheControl: r.headers.get("cache-control"),
      };
      console.log("[poc] viewer-file:", JSON.stringify(viewerResult));
    }
  }

  await api.post("/control/kill", { id });
  await sleep(5000);
  srv.kill("SIGTERM");
  await sleep(2000);

  console.log("\n=== 結果 ===");
  console.log(JSON.stringify({
    replied, pngExists: ok, pngBytes: ok ? statSync(OUT_ABS).size : 0,
    genSeconds: Number(genSec), totalSeconds: Number(((Date.now() - t0all) / 1000).toFixed(1)),
    viewer: viewerResult,
  }, null, 2));
  console.log("[poc] 撤収完了");
  process.exit(ok && replied && viewerResult?.pngMagic ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
