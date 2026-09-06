# 運用: 最終報告の自動転送（final-report relay / 逆方向通知 [C]）

実装: `src/server/finalReport.ts`（純関数）／`src/server/agent.ts`（発火判定）／`src/server/index.ts`（配送配線）
テスト: `test/finalReport.test.ts`（単体）／`scripts/e2e-reverse-notify.mjs` の **E**（e2e）
関連: [`imagegen-role.md`](./imagegen-role.md) ／ 様式の SoT は `src/server/imagegen.ts`

## 1. 直した故障（実測）

codex バックエンドの imagegen エビが、画像生成を全部終えたあと
**`reply_to_master` を呼ばずに `imagegen_result: v1` の YAML を自分の TUI に書いて idle になる**。
master には何も届かず、ボス／master がナッジするまで止まる。

- 再現: 2026-09-05 のスモークと 2026-09-06 の武器画像ジョブ（14 枚）で **3 回中 3 回**。
  ナッジすると届く＝ツールは配られているし呼べる（起動時の MCP 未登録問題ではない）。
- 一次証拠: ジョブ `vc-weapon-imagegen` の scrollback（`GET /control/scrollback?id=…`）。
  ANSI を除去すると、末尾のターンはこう終わっている:

  ```
  • bow_yew は追加3試行もすべて RGB でした。13枚は合格を維持し…
    imagegen_result: v1
    job_id: guild-rpg-weapons
    …（126 行）…
    gen_seconds: 65.6
  ─ Worked for 4m 07s ─────────────────────────────
  ```

  `reply_to_master` のツール呼び出しは 1 度も現れず、**素のテキストとして** YAML を書いて
  ターンを終えている。役割プロンプトには「(3) 最後に reply_to_master を 1 回だけ呼んで報告する。
  チャットに書いた文章は master に届かない」と既に書いてあり、**指示追従に頼る対策は実測で落ちる**。

### なぜ既存の保険が拾えなかったか

逆方向通知は 3 段になった。従来は 2 段しかなく、どちらも効かなかった。

| 段 | 何をするか | この故障で効かない理由 |
|----|-----------|----------------------|
| [A] `reply_to_master` | エビが明示的に報告 | **呼ばれない**のが故障そのもの |
| [B] idle 自動通知 | 「待機に入りました」だけ送る（本文なし） | 本番の `npm start` が `EBI_IDLE_NOTIFY=off`（通知洪水を嫌ったため）。仮に on でも本文が無く、master は `read_scrollback` が要る |
| **[C] 最終報告の自動転送（本 PR）** | ターン末の出力から**報告ブロックを本文ごと**拾って `[reply]` で送る | — |

## 2. どう動くか

`busy → idle` のエッジで、**そのターンに出力された scrollback だけ**を走査し、
所定マーカーのブロックを切り出して master へ `kind:"reply"` で届ける。

発火条件（すべて満たすときだけ・`agent.ts` の `maybeRelayFinalReport`）:

1. `EBI_FINAL_REPORT_RELAY` が off でない（既定 on）
2. master / supervisor 以外
3. 一度でも ready 済み（起動直後の初期化 idle で誤発火しない）
4. **直近 `EBI_REPLY_SUPPRESS_MS`（既定 5 秒）に `reply_to_master` が無い**
   ＝ 本人がツールで報告できたときは何もしない（二重報告を作らない）
5. 所定マーカーのブロックが在る
6. 直前に転送したのと同一本文ではない（再描画の二重送信よけ）

master に届く形（本文ごと届くので `read_scrollback` は不要）:

```
[from:vc-weapon-imagegen#123] [reply] [自動転送] vc-weapon-imagegen が reply_to_master を
呼ばずにターンを終えたため、セッション出力から最終報告（imagegen_result）を拾って転送します。
本人の発言そのままではないので、疑わしければ read_scrollback で確認してください。
imagegen_result: v1
job_id: guild-rpg-weapons
…
```

### 誤配送を出さないための錠前

「最後の発言をそのまま送る」には**していない**。転送するのは `FINAL_REPORT_MARKERS`
（現在は `imagegen_result` だけ）に当たったブロックのみで、さらに 2 段の錠前がある。

1. マーカーは**行頭**（インデントのみ許容）で、その行が `imagegen_result: v1` **だけ**であること
2. 切り出したブロックに `job_id: <値>` が**行頭**で在ること

役割プロンプトのエコー（`… imagegen_result: v1 / job_id / summary / …` の 1 行）は
1 で落ち、TUI がどの幅で折り返しても 2 の `job_id` にコロンが付かないので当たらない。
ブロックは TUI の枠線・入力プロンプト（`─ Worked for …` / `› …` / `• …`）で必ず終端する。
`test/finalReport.test.ts` が実測文字列（役割プロンプト全文を 7 通りの幅で折り返したもの含む）で
この錠前を機械照合している。

### ANSI 除去の落とし穴

codex TUI は毎フレーム **`ESC [ 0 <space> q`**（カーソル形状指定＝中間バイト付き CSI）を吐き、
これが YAML の各行末に大量にぶら下がる。既存の簡易パターン
（`\x1b\[[0-9;?]*[a-zA-Z]`）は中間バイトを見ないのでこれを取りこぼし、素文に `[0 q` が残って
行照合が全滅する。`finalReport.ts` の `stripAnsi` は CSI の文法どおり
（パラメータバイト → 中間バイト → 終端バイト）に落とす。

## 3. 設定

| env | 既定 | 意味 |
|-----|------|------|
| `EBI_FINAL_REPORT_RELAY` | `on` | `off` / `0` / `false` で [C] を無効化（非常口） |
| `EBI_REPLY_SUPPRESS_MS` | `5000` | [A] を呼んだ直後は [B] も [C] も黙る窓（既存） |

[B]（`EBI_IDLE_NOTIFY`）とは**別の口**にしてある。本番の `npm start` は B を off で常用している
ため、そこへ相乗りすると直したい故障がそのまま残る。C はマーカーに当たったときだけ出るので
通知洪水にはならない。

## 4. 反映（サーバ再起動が要る・ボス／master が行う）

サーバ本体（`src/server/`）の変更なので、**config の書き換えだけでは効かない**。

```bash
cd ~/workspace/GitHub/ebi-team
git pull                     # main へマージ後
npm run build && npm start   # 本番。dev は npm run dev（tsx watch が拾う）
```

- **走行中のエビは全部落ちる**（サーバ終了時に `killAll`）。再起動後に自動復帰するのは
  `fixedEbi`（master / supervisor / minaebi 等）だけで、動的エビ（imagegen・engineer）は
  復帰しない。**画像生成ジョブや実装タスクが走っていないタイミングで入れ直すこと。**
- 未回収の報告があるなら、再起動前に `read_scrollback` で拾っておく（プロセスを落とすと
  scrollback も破棄される）。
- `roles.imagegen` の役割プロンプトも合わせて強めてある（[B] 補助）。
  リポジトリ側は `ebi-team.config.example.json` を更新済みなので、稼働 config
  （`ebi-team.config.json`・git 管理外）の `roles.imagegen.appendSystemPrompt` の
  `【報告】` 節を同じ文面に差し替える。差し替えなくても [C] は効く。

## 5. 効いているかの確認

```bash
# サーバログ（notice にも出る）
#   [ebi-team] [<id>] 最終報告の自動転送: imagegen_result を検出しました（…）
# 実測どおりの疎通は e2e で固定済み（実課金なし・bash エビで再現）
env -u EBI_ID EBI_IDLE_NOTIFY=on npm run e2e:reverse-notify   # E セクションが OK になる
npm test                                                       # test/finalReport.test.ts
```

## 6. マーカーを増やすとき

`src/server/finalReport.ts` の `FINAL_REPORT_MARKERS` に 1 エントリ足す（`start` と `require` の
2 段の錠前を必ず両方書く）。汎用の「最後の発言をそのまま送る」には広げないこと——
誤配送の抑制が効かなくなり、master のコンテキストを雑談で埋める。
