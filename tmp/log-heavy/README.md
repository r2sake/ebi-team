# log-heavy 計測ハーネス（2026-09-07）

`docs/log-heavy-PLAN.md` の実測値を再現するための一式。

```bash
node tmp/log-heavy/gen-events.mjs                              # 実ログ→計測用 JSON
npx vite --config tmp/log-heavy/vite.harness.config.ts &       # 5175 番（8787 は本番サーバ）
node tmp/log-heavy/measure.mjs                                 # 初期描画 / DOM / streaming
node tmp/log-heavy/measure2.mjs                                # 主因の切り分け
kill %1
```

playwright はリポジトリの依存ではないので、`measure*.mjs` の import は npx キャッシュの
絶対パスを指している。環境が変わったら書き換えること。
