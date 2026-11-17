import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * セキュアモード（env EBI_SECURITY_MODE > ebi-team.config.json の securityMode）のときは、
 * dev サーバを LAN に開かない（host を localhost のみにする）。standard は従来どおり host: true。
 * env EBI_VITE_HOST（"true" / "false" / ホスト名）で明示的に上書きできる。
 */
function isSecureMode(): boolean {
  const env = process.env.EBI_SECURITY_MODE?.trim();
  if (env) return env !== "standard";
  try {
    const path = process.env.EBI_CONFIG_PATH ?? join(process.cwd(), "ebi-team.config.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as { securityMode?: unknown };
    return raw.securityMode !== undefined && raw.securityMode !== "standard";
  } catch {
    return false;
  }
}

function devHost(): boolean | string {
  const v = process.env.EBI_VITE_HOST?.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (v) return v;
  return isSecureMode() ? false : true;
}

// フロントエンド（src/client）の Vite 設定。
// 開発時は dev サーバ（既定 5173 番）を立て、WebSocket は別ポートの
// Node サーバ（既定 8787 番）へ proxy する。
export default defineConfig({
  root: "src/client",
  publicDir: "../../public",
  server: {
    port: 5173,
    // 常に 5173 で待つ。空いていなければ別ポートへずらさず起動失敗させ、
    // 「いつも http://localhost:5173」でアクセスできる状態を保証する。
    strictPort: true,
    // 同一 LAN の他端末（スマホ等）からも見たい場合に有効。セキュアモードでは既定で外す（devHost）。
    host: devHost(),
    proxy: {
      // ブラウザは同一オリジンの /ws へ接続し、Vite が Node サーバへ転送する。
      "/ws": {
        target: "ws://localhost:8787",
        ws: true,
      },
      // 画像 viewer のバイナリ配信（<img src="/control/viewer-file?id=...">）など、
      // 制御API も同一オリジンで叩けるように Node サーバへ転送する。
      "/control": {
        target: "http://localhost:8787",
      },
    },
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
});
