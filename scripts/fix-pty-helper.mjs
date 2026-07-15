// node-pty 1.1.0 の既知問題対策スクリプト。
// prebuilds に同梱される spawn-helper が npm 展開時に実行権限を失い、
// PTY spawn が `posix_spawnp failed` で失敗することがある。
// postinstall でこのバイナリへ実行権限を付け直す（macOS / Linux 向け）。
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const prebuildsDir = join(__dirname, "..", "node_modules", "node-pty", "prebuilds");

if (!existsSync(prebuildsDir)) {
  // Windows や勝手にローカルビルドされた場合は対象外なので静かに終了。
  process.exit(0);
}

let fixed = 0;
for (const dir of readdirSync(prebuildsDir)) {
  const helper = join(prebuildsDir, dir, "spawn-helper");
  if (existsSync(helper)) {
    try {
      chmodSync(helper, 0o755);
      fixed += 1;
    } catch (err) {
      console.warn(`[fix-pty-helper] chmod 失敗: ${helper}`, err);
    }
  }
}

if (fixed > 0) {
  console.log(`[fix-pty-helper] spawn-helper に実行権限を付与しました（${fixed} 件）`);
}
