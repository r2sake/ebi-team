# 検証: imagegen 役割のスモーク（実画像 2 枚）

実施: 2026-09-05 / ブランチ `ebi/ebiteam-imagegen-role-impl` / 設計 [`../design/imagegen-role-2026-09-05.md`](../design/imagegen-role-2026-09-05.md)
ドライバ: `npm run e2e:imagegen`（`scripts/e2e-imagegen.mjs`・専用ポート **8813**）
枠の消費: **画像 2 枚**（ボス裁定 A3 の上限ちょうど）。稼働サーバ（8787）には触れていない。

## 結論

**PASS。** 依頼 YAML → 生成 → `sips -Z` / `cwebp` → 報告 YAML → ファイル実測まで一気通貫で通った。
報告 YAML は様式（`imagegen_result: v1`）どおりで、`pixels` も実測と一致した。ACK 誤検知（静かな故障判定）は起きていない。

## 実測

| 項目 | 値 |
|---|---|
| spawn 所要 | 0.7 s |
| 依頼注入 → `[reply]` 着弾 | **171.7 s**（2 枚・ウォームアップと仕上げ込み） |
| エビ自己申告の `gen_seconds` | 71 |
| ターン数 | ACK 1 ＋ 生成 ＋ 仕上げ 1 シェル ＋ 報告 1（設計の `N+3` に収まる） |

| id | format | 指定 | 実測 pixels | bytes |
|---|---|---|---|---|
| `smoke-icon` | png | 512x512 / contain | **512x512** | 209,402 |
| `smoke-mark` | webp | 256x256 / contain | **256x256** | 5,162 |

生成物のサンプル（WebP）: [`imagegen-smoke-2026-09-05.webp`](./imagegen-smoke-2026-09-05.webp)

エビが返した報告（そのまま・パスは worktree）:

```yaml
imagegen_result: v1
job_id: smoke-imagegen
summary: "ok: 2, failed: 0, refused: 0, skipped: 0"
results:
  - id: smoke-icon
    status: ok
    path: /Users/yoimaro/workspace/GitHub/ebi-team/.worktrees/ebi-ebiteam-imagegen-role-impl/tmp/images/smoke-imagegen/smoke-icon.png
    pixels: 512x512
    bytes: 209402
    format: png
    tool: image_gen__imagegen
  - id: smoke-mark
    status: ok
    path: /Users/yoimaro/workspace/GitHub/ebi-team/.worktrees/ebi-ebiteam-imagegen-role-impl/tmp/images/smoke-imagegen/smoke-mark.webp
    pixels: 256x256
    bytes: 5162
    format: webp
    tool: image_gen__imagegen
gen_seconds: 71
```

## 分かったこと（スモークで初めて見えた 3 点）

### 1. ACK 監視窓の短縮（`ackWatchMs: 45000`）が効いている

サーバログに `ACK 監視を終了（上限時間に達した）` が **45 秒時点**で出て、その後 171 秒の報告が来た。
既定の 90 秒のままだと、**正しい報告**が監視窓の内側に落ちて「静かな故障」と誤判定される余地があった（設計 §6.4）。
`静かな故障を検知` はログに 1 度も出ていない（e2e が明示的に検査している）。

### 2. 役割プロンプトの `codex login` という並びが**偽の起動エラー通知**を立てた

```
[ebi-team] [ebi-1] 起動エラー: codex がログインを要求しています。`codex login` を実行してから再 spawn してください
```

正常に起動して生成も成功しているのに出た。原因は `src/server/backends/codex.ts` の
`fatalPatterns` の `/(codex login|Not logged in|Please (re)?login)/i` に、
**役割プロンプト本文のエコー**（ボス裁定 A5 の「認証切れなら codex login のやり直しを依頼」）が一致したこと。
ACK 検知語（`profiles.ts`）と同じ罠が `fatalPatterns` 側にもある。

→ 対応: 案内文を「**Codex の再ログイン（codex の login をやり直す）**」に言い換えて並びを崩した
（SoT は `src/server/imagegen.ts` の `CODEX_RELOGIN_HINT`）。
`test/imagegen.test.ts` と `test/codexAckRespawn.test.ts` に、
config の役割プロンプトを **ACK 検知語と fatalPatterns の両方**で走査するケースを足して錠前を掛けた。
影響は notice 1 行のみ（kill / respawn はしない実装）なので、スモークの成否には効いていない。

### 3. WebP 変換後の中間 PNG が残った

`tmp/images/smoke-imagegen/` に `smoke-mark.webp` と一緒に `smoke-mark.png`（43,238 B）が残った。
初版の役割プロンプトが「cwebp で変換する」までしか書いておらず、中間 PNG の削除を指示していなかった。

→ 対応: 役割プロンプトに「変換に成功したら中間の PNG を消して WebP だけ残す」を追記した。
**この追記は再実行での確認をしていない**（ボス裁定 A3 の枠が 2 枚ちょうどのため）。次のジョブで確認する。

## 未確認のまま残したこと

- 上の 3. の中間 PNG 削除（プロンプト追記のみ・ライブ未確認）。
- `regenerate: [id]` による id 指定の作り直し（unit テストでは検証済み・ライブ未実行）。
- 1 回の `exec` で複数枚まとめて生成できるか（設計 §1.2 の上積み・今回は 2 枚とも個別生成に見える）。
- 失敗系（`GEN_TOOL_OFF` / `REFUSED`）の実挙動。意図的に起こすと枠を使うため見送った。
