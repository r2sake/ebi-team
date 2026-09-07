import { defineConfig } from "vite";
// 計測用ハーネス専用の Vite 設定（root をリポジトリ直下にして src/client と tmp/ の両方を配れるようにする）。
export default defineConfig({
  root: ".",
  server: { port: 5175, strictPort: true },
});
