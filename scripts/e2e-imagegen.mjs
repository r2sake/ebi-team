// imagegen 役割のスモーク e2e（設計 PR-2 / ボス裁定 A3: 実画像 2 枚ぶんの Plus 枠を使う）。
//
// 依頼 YAML → codex エビ spawn → image_gen で 2 枚生成 → sips -Z / cwebp で正規化 →
// reply_to_master の報告 YAML → 様式検証 → 実ファイルのピクセル/バイト実測、までを一気通貫で見る。
//
// 安全策:
// - 稼働サーバ（8787）には触らない。専用ポート（既定 8813）で自前起動し、mkdtemp した状態
//   ディレクトリで完結する。master は bash の使い捨てエビ（claude を起動しない）。
// - 役割定義は ebi-team.config.example.json の roles.imagegen を**そのまま**読み込む
//   （稼働 config に入れる文面と同じものを検証する）。
//
//   npm run e2e:imagegen            # 実際に Plus 枠を使う（2 枚）
//   EBI_E2E_IMAGEGEN_DRY=1 npm run e2e:imagegen   # 生成せず依頼/報告様式の検証だけ
//
// 実測メモは docs/verify/imagegen-role-<date>.md に残すこと。

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PORT = Number(process.env.EBI_E2E_PORT ?? 8813);
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = Number(process.env.EBI_E2E_TIMEOUT_MS ?? 480000);
const DRY = process.env.EBI_E2E_IMAGEGEN_DRY === "1";
const JOB_ID = process.env.EBI_E2E_JOB_ID ?? "smoke-imagegen";
const DEST_REL = `tmp/images/${JOB_ID}`;
const DEST_ABS = join(ROOT, DEST_REL);

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

/** 依頼 YAML（2 枚 = png 512 と webp 256。sips -Z と cwebp の両方を通す）。 */
const JOB_YAML = `imagegen_job: v1
job_id: ${JOB_ID}
requester: e2e
dest_root: ${DEST_REL}
images:
  - id: smoke-icon
    purpose: スモーク用のアイコン（PNG・長辺 512 に正規化）
    prompt: |
      白背景に、エビのマスコットのシンプルでかわいいフラットアイコン。
      太めの輪郭線、彩度低めのオレンジ、影なし。文字は入れない。
    count: 1
    size: 512x512
    fit: contain
    format: png
  - id: smoke-mark
    purpose: スモーク用のマーク（WebP・長辺 256 に正規化）
    prompt: |
      白背景に、エビのしっぽだけを図案化した単色のシンプルなマーク。
      線は太め、影なし。文字は入れない。
    count: 1
    size: 256x256
    fit: contain
    format: webp
notes: |
  2 枚とも同じトーンで揃えること。人物・実在ロゴ・文字は入れない。
`;

function readImagegenRole() {
  const cfg = JSON.parse(readFileSync(join(ROOT, "ebi-team.config.example.json"), "utf8"));
  const role = cfg.roles?.imagegen;
  if (!role) throw new Error("ebi-team.config.example.json に roles.imagegen がありません");
  return role;
}

function writeConfig(dir, role) {
  const p = join(dir, "config.e2e.json");
  writeFileSync(p, JSON.stringify({
    fixedEbi: [{ id: "master", kind: "master", cwd: ROOT, command: "bash", args: ["-c", "echo MASTER_UP; exec cat"], notifySubscribe: false }],
    roles: { imagegen: role },
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

/** master の scrollback から imagegen_result の YAML ブロックを切り出す。 */
function extractResultYaml(text) {
  const i = text.lastIndexOf("imagegen_result:");
  if (i < 0) return null;
  // 端末幅で折り返された行を戻すことはできないので、そのままの塊を返す（検証側で吸収）。
  return text.slice(i);
}

function measure(path) {
  const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8" });
  const w = /pixelWidth:\s*(\d+)/.exec(out)?.[1];
  const h = /pixelHeight:\s*(\d+)/.exec(out)?.[1];
  return { pixels: `${w}x${h}`, bytes: statSync(path).size };
}

async function main() {
  const { parseImagegenJob, targetImages, outputFileNames } = await import("../src/server/imagegen.ts");

  // 1) 依頼 YAML が様式を満たすこと（ここが落ちたら枠を一切使わずに終わる）。
  const job = parseImagegenJob(JOB_YAML);
  const expected = targetImages(job).flatMap((s) => outputFileNames(s).map((f) => ({ spec: s, file: f })));
  console.log(`[e2e] 依頼 OK: job_id=${job.jobId} dest=${job.destRoot} ${expected.length} 枚`);
  for (const e of expected) console.log(`  - ${e.file} (${e.spec.size ? `${e.spec.size.width}x${e.spec.size.height}` : "リサイズなし"})`);
  if (DRY) { console.log("[e2e] DRY=1 のため生成はしません"); return 0; }

  rmSync(DEST_ABS, { recursive: true, force: true });
  mkdirSync(DEST_ABS, { recursive: true });

  const tmpDir = mkdtempSync(join(tmpdir(), "ebi-e2e-imagegen-"));
  const srv = startServer(tmpDir, writeConfig(tmpDir, readImagegenRole()));
  console.log(`[e2e] server pid=${srv.pid} port=${PORT} tmp=${tmpDir}`);
  let rc = 1;
  try {
    if (!(await waitForServer())) { console.error("[e2e] server 起動失敗"); return 1; }

    const tSpawn = Date.now();
    const sp = await api.post("/control/spawn", { role: "imagegen", cwd: ROOT });
    console.log("[e2e] spawn:", sp.status, JSON.stringify(sp.body));
    const id = sp.body?.id;
    if (!id) return 1;
    console.log(`[e2e] spawn 所要 ${((Date.now() - tSpawn) / 1000).toFixed(1)}s`);

    const tSend = Date.now();
    const snd = await api.post("/control/send", { to: id, from: "master", message: JOB_YAML });
    console.log("[e2e] send:", snd.status, JSON.stringify(snd.body));

    let masterTxt = "";
    let replied = false;
    for (;;) {
      masterTxt = await api.scrollback("master");
      if (/\[reply\]/.test(masterTxt)) { replied = true; break; }
      if (Date.now() - tSend > TIMEOUT_MS) { console.log("[e2e] タイムアウト"); break; }
      await sleep(5000);
    }
    const elapsed = ((Date.now() - tSend) / 1000).toFixed(1);
    console.log(`[e2e] reply 着弾=${replied} 所要 ${elapsed}s`);
    console.log("=== master scrollback (tail) ===\n" + masterTxt.slice(-3000));

    // 2) 作られたファイルの実測（報告の pixels は端末折返しで壊れうるので、こちらが正）。
    let allOk = replied;
    for (const e of expected) {
      const p = join(DEST_ABS, e.file);
      if (!existsSync(p)) { console.error(`[e2e] NG: ${e.file} が作られていません`); allOk = false; continue; }
      const m = measure(p);
      const want = e.spec.size ? Math.max(e.spec.size.width, e.spec.size.height) : null;
      const got = Math.max(...m.pixels.split("x").map(Number));
      const sizeOk = want === null || got === want;
      console.log(`[e2e] ${sizeOk ? "OK" : "NG"}: ${e.file} pixels=${m.pixels} bytes=${m.bytes}（長辺の期待=${want ?? "-"}）`);
      if (!sizeOk) allOk = false;
    }
    // 3) ACK 誤検知（静かな故障判定）で作り直しが走っていないこと。
    const srvLog = await api.scrollback(id);
    if (/静かな故障を検知/.test(srvLog)) { console.error("[e2e] NG: ACK 誤検知が起きています"); allOk = false; }

    const yaml = extractResultYaml(masterTxt);
    console.log(yaml === null ? "[e2e] 報告 YAML ブロックは scrollback から取れませんでした" : "[e2e] 報告 YAML ブロックあり");
    rc = allOk ? 0 : 1;
    console.log(rc === 0 ? "[e2e] PASS" : "[e2e] FAIL");
  } finally {
    srv.kill("SIGTERM");
    await sleep(1500);
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return rc;
}

main().then((rc) => process.exit(rc)).catch((err) => { console.error(err); process.exit(1); });
