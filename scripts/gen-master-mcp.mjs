// 制御MCP 設定 JSON を「絶対パス入り」で生成するスクリプト（master / engineer の両ロール）。
//
// master の cwd は ebi-team 配下ではない（ebi-team.config.json の fixedEbi[].cwd で指定する
// 任意のプロジェクトディレクトリ）。そのため --mcp-config の command/args/cwd は絶対パスである必要がある。
// このスクリプトは ebi-team のルートを基準に解決し、生成物を .ebi-team/ 配下へ書き出す。
//
// 生成物（同一の control-server.ts を起動するが、EBI_MCP_ROLE でツールセットを出し分ける）:
//   - master-control(.dev).mcp.json   … EBI_MCP_ROLE=master（既定）。配下統括ツール一式。
//   - engineer-control(.dev).mcp.json … EBI_MCP_ROLE=engineer。reply_to_master + 参照系のみ。
//
// engineer config のポイント:
//   - EBI_ID は config に焼かない。engineer の pty 起動時に env で注入し、子の stdio MCP が
//     継承する（→ reply_to_master の from に自分の id が入る）。同一 config を全 engineer で共有可。
//   - engineer は --strict-mcp-config を付けずに --mcp-config で「追加」ロードする想定
//     （index.ts 側の配線）。作業に必要な既存環境を保ちつつ ebi-control を足す。
//
// 使い方:
//   node scripts/gen-master-mcp.mjs           # 本番（dist/server/mcp/control-server.js を node 起動）
//   node scripts/gen-master-mcp.mjs --dev      # 開発（src/mcp/control-server.ts を tsx 起動）
//   EBI_CONTROL_URL=http://127.0.0.1:9999 node scripts/gen-master-mcp.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dev = process.argv.includes("--dev");
const controlUrl = process.env.EBI_CONTROL_URL ?? "http://127.0.0.1:8787";

const server = dev
  ? { command: "npx", args: ["tsx", join(root, "src/mcp/control-server.ts")] }
  : { command: "node", args: [join(root, "dist/server/mcp/control-server.js")] };

const outDir = join(root, ".ebi-team");
mkdirSync(outDir, { recursive: true });

/** role 別の mcp config を組み立てて書き出し、パスを返す。 */
function genConfig(role, fileName) {
  const config = {
    mcpServers: {
      "ebi-control": {
        command: server.command,
        args: server.args,
        cwd: root,
        // EBI_ID は焼かない（engineer は pty env から継承）。role と接続先のみ固定する。
        env: { EBI_CONTROL_URL: controlUrl, EBI_MCP_ROLE: role },
      },
    },
  };
  const outPath = join(outDir, fileName);
  writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n");
  return outPath;
}

const masterPath = genConfig("master", dev ? "master-control.dev.mcp.json" : "master-control.mcp.json");
const engineerPath = genConfig("engineer", dev ? "engineer-control.dev.mcp.json" : "engineer-control.mcp.json");

console.log(`生成(master):   ${masterPath}`);
console.log(`生成(engineer): ${engineerPath}`);
console.log(`ebi-team.config.json の master args に追加してください:`);
console.log(`  "args": ["--strict-mcp-config", "--mcp-config", "${masterPath}"]`);
console.log(`  加えて master 定義に "notifySubscribe": false を付け、受信を PTY 注入に固定します。`);
console.log(`各役割は spawn 時にサーバが自動で役割別 --mcp-config を付与します（EBI_ID は env 継承）。`);
console.log(``);
console.log(`※ master args には --dangerously-load-development-channels を付けないでください。付けると`);
console.log(`  harness が master セッションを『開発チャンネルをロードする＝バックグラウンドジョブ/サブ`);
console.log(`  エージェント』扱いにし、master 宛メッセージが黙って全損する既知トラップがあります。ebi-control`);
console.log(`  の channel 登録が要るのは reply_to_master を『送信する側』の役割エビだけで、それは index.ts が`);
console.log(`  notify モード時に自動付与します（起動ゲートは agent.ts の自動応答が越える。README / registry.ts 参照）。`);
