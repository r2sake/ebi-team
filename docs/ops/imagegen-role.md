# 運用: imagegen 役割（画像生成エビ）

設計: [`../design/imagegen-role-2026-09-05.md`](../design/imagegen-role-2026-09-05.md) ／ 検証: [`../verify/imagegen-role-2026-09-05.md`](../verify/imagegen-role-2026-09-05.md)
様式の SoT: `src/server/imagegen.ts` ／ サンプル: `docs/samples/imagegen-*.yaml`

## 1. 稼働 config への追加（ボスが再起動して反映）

役割はコードではなく **`ebi-team.config.json` の top-level `roles`** に置く（dist の再ビルドは不要・サーバ再起動だけで効く）。

```bash
cd ~/workspace/GitHub/ebi-team
cp -p ebi-team.config.json ebi-team.config.json.bak.$(date +%Y%m%d-%H%M%S)   # 先にバックアップ
# ebi-team.config.example.json の roles.imagegen をそのまま roles へ足す
python3 -c "import json;print(json.dumps(json.load(open('ebi-team.config.example.json'))['roles']['imagegen'],ensure_ascii=False,indent=2))"
python3 -c "import json;json.load(open('ebi-team.config.json'))" && echo "JSON OK"
```

反映はサーバ再起動（`npm start` / `npm run dev` の入れ直し）。**ボスが行う。**

### 再起動後の確認手順（3 つ）

```bash
# 1) 役割が登録されたか（起動ログに roles の読み込み警告が出ていないこと）
curl -s localhost:8787/control/agents >/dev/null && echo "server OK"
# 2) 生成せずに spawn だけして役割が引けるか（枠を使わない）
curl -s -XPOST localhost:8787/control/spawn -H 'Content-Type: application/json' \
  -d '{"role":"imagegen","cwd":"'"$HOME"'/workspace/GitHub/ebi-team"}'
# → {"id":"ebi-N"} が返る。エラーなら role 未登録（config の JSON か mcpRole を疑う）
# 3) 確認できたら片付ける
curl -s -XPOST localhost:8787/control/kill -H 'Content-Type: application/json' -d '{"id":"ebi-N"}'
```

master 側は再起動後に `spawn_ebi` の `role` に `imagegen` が選べるようになる（master 用 MCP ブリッジが起動時の config から選択肢を作るため、**master セッションの再起動が要る**）。

## 2. 依頼の投げ方

```
send_message({ to: "imagegen-1", spawnIfMissing: true, role: "imagegen", message: "<依頼 YAML>" })
```

依頼 YAML は `docs/samples/imagegen-job.yaml` の形。投げる前に形だけ確かめられる:

```bash
npm run imagegen:check -- job /path/to/job.yaml
```

決めごと（ボス裁定 2026-09-05）:

| 項目 | 決め |
|---|---|
| 保存先 | ebi-team の `tmp/images/<job_id>/`（`.gitignore` 済み）。**採否を見てから** master / engineer が対象リポジトリの assets へ配る |
| 1 ジョブの上限 | **6 枚**（`count` の合計）。超える分は `status: skipped` / `error_code: OVER_LIMIT` |
| 作り直し | 同じ依頼 YAML に `regenerate: [id, ...]` を足して**再投入**する。その id だけが作り直され、他は触られない |
| 加工 | リサイズ（`sips -Z` の長辺合わせ）と PNG→WebP（`cwebp -q 90`）**だけ**。減色・トリム・切り抜き・背景除去は禁止 |
| 待ち時間の目安 | 90 s × 枚数 ＋ 120 s（2 枚の実測 171.7 s） |

報告は `reply_to_master` 1 回・`imagegen_result: v1` の YAML 1 ブロック。`path` は絶対パスなので `open_viewer({path})` にそのまま渡せる。

## 3. 失敗したとき

| `error_code` | master の次の一手 |
|---|---|
| `GEN_TOOL_OFF` | **再 spawn しても同じ。** 報告の `note` に出る「Codex の再ログインを依頼」をボスへそのまま渡す（ChatGPT Plus の認証切れ・プラン切れ） |
| `REFUSED` | プロンプトを書き換えて**新しいジョブ**で投げ直す（同じ文言の再送は枠の無駄） |
| `GEN_ERROR` | 1 枚なら再依頼。複数枚が同じなら `GEN_TOOL_OFF` を疑う |
| `RESIZE_ERROR` / `TOOL_MISSING` | 元 PNG は残っているので手元で `sips -Z` / `cwebp` |
| `OVER_LIMIT` | ジョブを分けて投げ直す |

`GEN_TOOL_OFF` の一次診断（ボス／master が手で 2 コマンド）は設計 §6.2 を参照。

## 4. 生成物の掃除

codex の画像生成ツールは `~/.codex/generated_images/<uuid>/` を作り続ける（1 枚 ≒ 0.8〜0.9 MB）。
**エビには掃除させない**（他セッションが生成中のディレクトリを消す事故を避けるため）。手か週次で回す:

```bash
ops/clean-generated-images.sh --dry-run   # 対象を見る
ops/clean-generated-images.sh             # 7 日より古いものを削除
ops/clean-generated-images.sh --days 30
```

ebi-team 側の `tmp/images/<job_id>/` は `.gitignore` 済み。採用が決まって配り終えたらディレクトリごと消してよい。

## 5. 役割プロンプトを書き換えるときの注意

役割プロンプトは注入時に codex の TUI がそのままエコーし、**サーバの 2 つの走査**に必ず掛かる。

1. ACK 誤検知（`src/server/backends/profiles.ts` の `CODEX_ACK_FAILURE_PATTERNS`）→ 当たると**無駄な作り直し**が走る
2. 起動エラー検知（`src/server/backends/codex.ts` の `fatalPatterns`）→ 当たると**偽の「起動エラー」通知**が出る（実害は通知だけ）

`test/codexAckRespawn.test.ts` が `ebi-team.config.example.json` と（存在すれば）稼働 `ebi-team.config.json` の
役割プロンプトを両方の走査に掛けている。書き換えたら `npm run test:unit` を通すこと。

```bash
EBI_CONFIG_PATH=~/workspace/GitHub/ebi-team/ebi-team.config.json npm run test:unit
```
