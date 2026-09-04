// 画像生成 PoC（2026-09-05）の C: ebi-team のエビとして spawn した codex / gemini に
// 「<worktree>/tmp/imagegen/*.png を生成せよ」と指示し、結果を回収する使い捨てドライバ。
//
// 安全策: 稼働サーバ（8787）には一切触らない。専用ポート（既定 8811）で control-server を
// 自前起動し、mkdtemp した状態ディレクトリで完結する。master は bash の使い捨てエビ。
//
//   node scripts/poc-imagegen-ebi.mjs codex
//   node scripts/poc-imagegen-ebi.mjs gemini

import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const BACKEND = process.argv[2] ?? "codex";
const PORT = Number(process.env.EBI_POC_PORT ?? 8811);
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = Number(process.env.EBI_POC_TIMEOUT_MS ?? 300000);

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
        label: "画像生成 PoC 係", emoji: "🎨",
        // ファイルを書ける必要がある。gemini は auto_edit だと WriteTodos 等の承認ダイアログで
        // 止まり注入が食われる（docs/backends/gemini.md §4）ので yolo（=bypassPermissions）にする。
        // codex は workspace-write（=acceptEdits）で十分。
        permissionMode: BACKEND === "gemini" ? "bypassPermissions" : "acceptEdits",
        appendSystemPrompt:
          "あなたは画像生成 PoC 係。作業結果の報告は必ず reply_to_master ツールで送ること" +
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
  "[poc-imagegen] このリポジトリの tmp/imagegen/ に、エビ（shrimp）のマスコットキャラクターの PNG 画像を" +
  `1 枚生成して ${BACKEND}-shrimp.png という名前で保存してください。` +
  "AI の画像生成ツール（codex なら組み込み image_gen、gemini なら画像生成モデル/拡張）が使えるなら必ずそれを使ってください。" +
  "使えない場合は、何を試して何と言われたかを 3 行以内で reply_to_master に報告してください。" +
  "作業が終わったら結果（生成できたか／ファイルパス／使った経路）を reply_to_master ツールで 1 回だけ報告してください。";

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "ebi-poc-imagegen-"));
  mkdirSync(join(ROOT, "tmp/imagegen"), { recursive: true });
  const srv = startServer(tmpDir, writeConfig(tmpDir));
  console.log(`[poc] server pid=${srv.pid} port=${PORT} tmp=${tmpDir}`);
  if (!await waitForServer()) { console.error("[poc] server 起動失敗"); srv.kill("SIGTERM"); process.exit(1); }

  const sp = await api.post("/control/spawn", { role: "imagegen", backend: BACKEND, cwd: ROOT });
  console.log("[poc] spawn:", sp.status, JSON.stringify(sp.body));
  const id = sp.body?.id;
  if (!id) { srv.kill("SIGTERM"); process.exit(1); }

  const snd = await api.post("/control/send", { to: id, from: "master", message: TASK });
  console.log("[poc] send:", snd.status, JSON.stringify(snd.body));

  const t0 = Date.now();
  let masterTxt = "";
  for (;;) {
    masterTxt = await api.scrollback("master");
    if (/\[reply\]/.test(masterTxt)) break;
    if (Date.now() - t0 > TIMEOUT_MS) { console.log("[poc] タイムアウト"); break; }
    await sleep(5000);
  }
  console.log("=== master scrollback ===\n" + masterTxt.slice(-3000));
  writeFileSync(join(ROOT, `tmp/imagegen/poc-${BACKEND}-ebi.txt`), await api.scrollback(id));
  console.log(`[poc] エビ画面を tmp/imagegen/poc-${BACKEND}-ebi.txt に保存`);

  await api.post("/control/kill", { id });
  await sleep(5000);
  srv.kill("SIGTERM");
  await sleep(2000);
  console.log("[poc] 撤収完了");
}
main();
