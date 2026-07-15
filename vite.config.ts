import { defineConfig } from "vite";

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
    // 同一 LAN の他端末（スマホ等）からも見たい場合に有効。不要なら false。
    host: true,
    proxy: {
      // ブラウザは同一オリジンの /ws へ接続し、Vite が Node サーバへ転送する。
      "/ws": {
        target: "ws://localhost:8787",
        ws: true,
      },
    },
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
});
