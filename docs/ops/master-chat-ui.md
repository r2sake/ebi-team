# master チャット UI の移行手順（terminal → chat）

- 対象: `fixedEbi[].ui`（`"terminal"` | `"chat"`）で切り替わる **master だけ**の UI 方式。作業エビ（engineer / supervisor / imagegen 等）は一切変わらない。
- 設計の一次資料: [`docs/design/master-chat-ui-2026-09-05.md`](../design/master-chat-ui-2026-09-05.md)（§6 移行 / §6.3 ロールバック / §9 PR 分割）
- backend 側の詳細: [`docs/backends/claude.md`](../backends/claude.md)（ヘッドレス master の仕組みとサブスク担保） / [`docs/backends/codex.md`](../backends/codex.md) §9（`brain:"codex"` は規約グレーの opt-in）

> **前提**: 既定は `terminal`（現行と完全に同じ PTY 経路）。`ui` を書かない限り、この機能は**サーバに載っているだけで一度も動かない**。

---

## 0. 3 行まとめ

1. 切り替えは **flag 1 個**（config の `ui` か env `EBI_MASTER_UI`）。ロールバックは値を戻して再起動するだけ（1 手）。
2. 本番（稼働ポート）へ入れる前に、**別ポート + `EBI_MASTER_UI=chat`** で 1 度動かして評価する（第 2 段）。
3. 会話は `.ebi-team/master-chat.jsonl` に残るが、**claude 側のセッションはサーバ再起動で切れる**（新しい会話として始まる）。§4 の表を参照。

---

## 1. 第 1 段: 何もしない（`ui` 未指定 = terminal）

chat 実装をマージした直後の状態。**外形はゼロ差分**で、確認することは「回帰が無いこと」だけ。

```bash
npm run build          # tsc + vite。成功すること
npm test               # unit（枠を消費しない）
npm run e2e:all-terminal   # terminal 経路の e2e 一式（※ 一部は実 claude を使う。§6）
```

- config に `ui` を書かない／env `EBI_MASTER_UI` を設定しない。
- master は従来どおり PTY で起動し、`reply_to_master` の受信も従来どおり（`notifySubscribe:false` ＝ PTY 注入）。
- チャット用の HTTP エンドポイント（`POST /control/chat-attach` / `GET /control/chat-attachment`）は **chat master が居ない構成では塞がる**（新しい書き込み口を増やさない）。

## 2. 第 2 段: 別ポートで試す（`EBI_MASTER_UI=chat`）

稼働中のサーバ（既定 8787）は **terminal のまま触らない**。評価は別ポートの使い捨てサーバで行う。

```bash
# 稼働 8787 とは別のポート・別の状態ディレクトリで起動する
EBI_PORT=8799 \
EBI_MASTER_UI=chat \
EBI_DUMP_PATH=/tmp/ebi-chat-eval/registry.json \
EBI_MASTER_CHAT_LOG_PATH=/tmp/ebi-chat-eval/master-chat.jsonl \
EBI_CHAT_ATTACH_DIR=/tmp/ebi-chat-eval/chat-attachments \
npm start
```

- ブラウザで `http://127.0.0.1:8799` を開くと、master のペインが **xterm ではなくチャット画面**になる（他のエビは従来どおりターミナル表示）。
- env `EBI_MASTER_UI` は **config より優先**する。不正値（`chat`/`terminal` 以外）は**無視**して起動を続ける（起動を止めない）。
- 稼働側と同じ `.ebi-team/` を使うと会話 JSONL と添付保管庫が混ざるので、上のように **別パスへ逃がす**こと。
- 停止は起動したプロセスの **PID 指定**で行う（広域 `pkill` はしない）。

見るポイント:

| 見るところ | 期待 |
| --- | --- |
| 送信 → 返答 | Enter で送信し、テキストが逐次描画される。⏹ で中断でき、その後も続けて話せる |
| エビからの返信 | 配下エビの `reply_to_master` が `[reply]` バブルとして流れる（PTY 注入は一切走らない） |
| ヘッダ | `$0.02 / ctx 31% / 5h 19% / 週 4%`。算出できない値は `—`（0% には化けない） |
| context-guard | 65 / 70 / 85% で notice が出る（供給元が statusLine から `turnEnd.usage` に変わっただけで判定は同一） |
| スマホ | 375px 幅でログが指スクロールできる（terminal 時代の詰まりが構造的に消える） |

## 3. 第 3 段: 本番を切り替える（config の `ui`）

`ebi-team.config.json` の master エントリに `ui` を入れる。

```jsonc
{
  "fixedEbi": [
    {
      "id": "master", "kind": "master",
      "ui": "chat",          // ← ここだけ。未指定なら terminal（現行）
      "brain": "claude",     // 省略可（既定 claude）。"codex" は規約グレーの opt-in
      "model": "fable",
      "permissionMode": "auto"
    }
  ]
}
```

反映手順は現行どおり（エビは稼働 dist / config / master-mcp を触らない）:

```bash
npm run build
node scripts/gen-master-mcp.mjs
# → ボスがサーバを再起動
```

- `ui:"chat"` は **`kind:"master"` 専用**。他の kind に書くと config 読み込み時に明示エラーで起動しない。
- `brain` の値域は `claude` / `codex` / `gemini` / `agy`。未実装 id（`gemini` / `agy`）は起動時に `MasterBrainNotImplementedError` で落ちる（黙って claude に落とさない）。
- `ui:"chat"` のとき `notifySubscribe` は参照されない（受信は stdin 一本）。`args` の `--mcp-config` 自動付与は従来どおり。

## 4. ロールバック

| 段 | 操作 | 効果 | 反映 |
| --- | --- | --- | --- |
| 1 | env `EBI_MASTER_UI=terminal` | config が `chat` でも terminal で起動する（最速の非常口） | 再起動 |
| 2 | config の `ui` を削除（または `"terminal"`） | 恒久的に現行へ戻る | 再起動 |
| 3 | chat 系 PR のみ revert | 作業エビ側は無影響（chat の変更は master 経路にしか触らない） | build + 再起動 |

### 再起動で切れるもの／残るもの

| もの | 実体 | 再起動で | 備考 |
| --- | --- | --- | --- |
| 会話ログ（表示用トランスクリプト） | `.ebi-team/master-chat.jsonl`（env `EBI_MASTER_CHAT_LOG_PATH`・`off` で無効） | **残る** | 起動時に直近ぶんを読み戻して chat 画面へ復元する（PTY 時代は再起動で消えていた＝改善） |
| claude 側の会話セッション | claude の session（`--resume <id>`） | **切れる** | サーバ再起動後は `--resume` なしで起動する＝**新しい会話**。頭脳プロセスだけが死んだ場合は `--resume` で自動復帰する（1s 指数バックオフ・上限 30s・短命死 5 連続で停止） |
| 累計コスト（ヘッダの `$`） | `MasterCostLedger`（メモリ） | **切れる**（0 から） | プロセスを跨いだ積算はするが、サーバを跨がない。「新しい会話」ボタンでもリセットされる |
| 文脈使用率（ヘッダの `ctx`） | `turnEnd.usage` | **切れる**（`—` から） | 次のターンが終わるまでは算出できないので `—` 表示 |
| 枠（`5h` / `週`） | `rate_limit_event` → `UsageStore` | **切れる** | アカウント単位の値なので、PTY エビが statusLine を投げれば埋まる（§5） |
| 添付ファイル | `.ebi-team/chat-attachments/`（env `EBI_CHAT_ATTACH_DIR`） | **残る** | 掃除は運用で行う（§7） |
| 入力履歴（↑/↓） | ブラウザの localStorage（`ebi-team.chat.inputHistory.v1`・直近 50 件） | **残る** | サーバ側には保存しない。別ブラウザ・別端末では共有されない |
| terminal 側の PTY スクロールバック | メモリ（リングバッファ） | 切れる | chat では PTY 自体を起動しない |

`ui` を terminal へ戻しても、`.ebi-team/master-chat.jsonl` と `chat-attachments/` は**残ったまま**になる（消さない）。再び chat に戻したとき、そのまま続きの表示として使われる。

## 5. ヘッダの枠表示（5h / 週）の出所に注意

ヘッダ右の `5h` / `週` は **アカウント単位の最新値（latest）** で、内訳は 2 つの供給元が混ざる。

- chat master の `rate_limit_event`（ヘッドレス claude が流してくる）
- PTY で動いている作業エビの statusLine が `POST /control/usage` に投げてくる `rate_limits`

どちらも同じアカウントの枠なので**値としては同じものを指す**が、「chat master が最後に観測した値」とは限らない（直前に engineer エビの statusLine が上書きしていることがある）。**chat master 単独の消費量を読み取る指標ではない**点に注意。

`ctx`（文脈使用率）は chat master 自身の `turnEnd.usage` だけを使うので、この混線は無い。

> **閾値の注意（設計 §8-R3 / 裁定 Q-6）**: context-guard の 65 / 70 / 85% は**割合据え置き**。opus-5 の文脈窓は 1,000,000 なので 65% = 650k トークンで、実運用の中央値（313k）ではそもそも発火しない。窓の小さいモデル（200k 等）を使うときだけ従来と同じ感覚で効く。

## 6. e2e の使い分け

| npm script | 何を通すか | 実 claude（枠を消費） |
| --- | --- | --- |
| `npm test` / `npm run test:unit` | unit のみ | 使わない |
| `npm run e2e:all-terminal` | `ui` 未指定（terminal）の一式: control / send / reverse-notify / notify-fallback / delivery-hardening / usage / viewer / viewer-persist / supervisor / fixed / minaebi / context-guard / spawn-delivery | **最後の `e2e:spawn-delivery` のみ使う** |
| `npm run e2e:all-chat` | chat 経路の一式: context-guard（偽 claude スタブ）→ master-chat → master-chat-image → master-chat-approval | **master-chat / master-chat-image / master-chat-approval の実配線チェックが使う** |
| `npm run e2e:context-guard` | terminal C1〜C5 ＋ chat D1〜D6（chat 側は `scripts/fake-claude-stream.mjs` を `claude` として PATH 先頭に置く） | 使わない |
| `npm run e2e:master-chat` | chat の往復 + `reverse-inject` → `inbound` を連続 10 回 | 使う（haiku・`EBI_E2E_CHAT_ROUNDS` で回数を減らせる） |
| `npm run e2e:master-chat-image` | 画像添付が実際に turn に届くか（色を答えさせる） | 使う（haiku・1 往復） |
| `npm run e2e:master-chat-approval` | 承認 / 質問の応答（ブローカ・MCP `permission_prompt`・UI 配線）17 チェック | 使う（haiku・承認 1 往復 + 質問 1 往復。`EBI_E2E_APPROVAL_REAL=0` で偽 claude のみに絞れる） |
| `npm run e2e:master-brain` | `ClaudeHeadlessBrain` 単体の 2 ターン結合 | 使う（opt-in） |
| `npm run compare:contextpct` | ヘッドレスの算出 `ctx%` と statusLine の突き合わせ | 使う（opt-in・haiku） |

いずれも**専用ポート + `mkdtemp` の使い捨て状態ディレクトリ**で完結し、稼働 8787 / `.ebi-team/` / `ebi-team.config.json` には触らない。

> **エビのセッションから e2e を回すときの注意**: ebi-team のエビ（サーバが spawn したセッション）の env には
> `EBI_IDLE_NOTIFY=off`（`npm start` / `npm run dev` が設定したものの継承）と `EBI_ID=<自分の id>` が入っている。
> これが e2e の立てる一時サーバにまで引き継がれると、**コードとは無関係に**
> `e2e:reverse-notify` の idle 自動通知チェックと `e2e:usage` の `EBI_ID` 注入チェックが落ちる。
> `e2e:all-terminal` / `e2e:all-chat` は先頭で `unset EBI_ID; export EBI_IDLE_NOTIFY=on` してからスクリプトを並べているので、
> **束ねた側を叩く限りこの罠は踏まない**。個別スクリプトを直接叩くときだけ
> `env -u EBI_ID EBI_IDLE_NOTIFY=on npm run e2e:usage` のように渡すこと。

## 7. 添付保管庫（`.ebi-team/chat-attachments/`）の掃除

- 保存先: `<cwd>/.ebi-team/chat-attachments/`（env `EBI_CHAT_ATTACH_DIR` で変更可）。ファイル名は `chat-<ts>-<rand>.<ext>` のみで、クライアントは basename しか扱えない（生パスを受け取らない＝パストラバーサルの入口を作らない）。
- 受理するのは `image/png` / `image/jpeg` / `image/gif` / `image/webp` / `text/plain` のみ。上限は **画像 12MB / テキスト 4MB**、1 発話あたり **4 枚**まで。
- **自動削除は無い**（会話 JSONL から参照され続けるため）。溜まりっぱなしになるので運用で消す。

容量の目安と掃除の例:

```bash
# いま何 MB あるか
du -sh .ebi-team/chat-attachments

# 30 日より古いものを消す（会話ログ上ではサムネイルが 404 になるだけで、会話本文は残る）
find .ebi-team/chat-attachments -type f -mtime +30 -delete
```

- 目安: スクリーンショット 1 枚 = 0.3〜2MB、大きな貼り付け（8,000 文字超は自動でファイル化）= 数十 KB。日に数回スクショを貼る使い方で **月あたり数百 MB** を見ておく。
- サーバを止めずに消してよい（保管庫はリクエストのたびに読む）。消した添付を含む過去の発話は、テキスト部分だけが残る。
- 会話そのものを畳みたいときは `.ebi-team/master-chat.jsonl` を退避（リネーム）してから再起動する。**削除ではなく退避**を勧める（過去の依頼の経緯が唯一残っている場所になりうるため）。

## 8. よくある詰まり

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| master のペインが従来どおりターミナルのまま | `ui` が未指定、または env `EBI_MASTER_UI=terminal` が優先されている | env を確認 → config に `"ui": "chat"` |
| 起動直後に master が停止して notice が出る | `ANTHROPIC_API_KEY` 等が env に残っている（従量課金への転落を防ぐ preflight が起動を拒否する） | env から外す（`docs/backends/claude.md` §2） |
| `brain:"gemini"` で起動しない | 未実装（裁定 Q-2 で対象外） | `claude`（既定）に戻す |
| ヘッダが全部 `—` | まだ 1 ターンも終わっていない | 1 往復すると埋まる |
| 承認 / 質問のバブルが出たまま master が止まる | 未応答の承認が 1 件でもあるとターンが進まない（**自動拒否もタイムアウトも無い**。§9 参照） | チャットのバブルで「許可 / 拒否」を答える（質問なら回答を選ぶ）。承認そのものを減らしたいなら `permissionMode: "auto"` の範囲で使う |

## 9. 承認 / 質問（permission / question）

`ui:"chat"` の master が承認の要るツール（Bash など）や `AskUserQuestion` を呼ぶと、チャットに**承認バブル**が出て、
入力欄の上に待ち件数のスティッキーバーが出る。**応答は UI から必須**で、答えるまでそのターンは進まない。

- **自動拒否はしない・タイムアウトも無い**（ボス裁定）。放置すると master は止まったままになる。
- 保留が消えるのは次の 4 系統だけ:
  1. ボスが UI で答えた（許可 / 拒否 / 質問への回答）
  2. HTTP 接続が切れた（claude 側がツール呼び出しを諦めた）
  3. 頭脳プロセスが終わった / 新しい会話になった
  4. サーバを再起動した
- 2〜4 はいずれも **deny で畳まれる**（ツールは実行されない）ので、「気付かないうちに実行されていた」は起こらない。
- 「以後このツールは常に許可」は持たない（毎回聞く）。`permissionMode: "auto"` を弱めないため。

**裏側の仕組み**（詰まったときの当たりを付ける用）:

- 承認の往復は claude の NDJSON には**一切現れない**。`--permission-prompt-tool mcp__<server>__<tool>` が指す
  MCP ツールの呼び出しとして届く（引数は `{tool_name, input, tool_use_id}`）。ebi-team ではこれが
  **`permission_prompt`（master ロール専用ツール。作業エビの MCP には露出しない）**。
- `--permission-prompt-tool` は **`--mcp-config` があるときだけ**付ける。無い状態で付けると
  `MCP tool ... not found. Available MCP tools: none` で**起動即死**する（隠しフラグ・2.1.258 で動作確認）。
- 決着は `permissionSettled` として会話 JSONL に載るので、再接続 / 再起動のあとに
  「どのバブルをまだ出してよいか」が復元できる。サーバ再起動時、未決着のものは `discarded` として畳まれる。
- 受け入れ e2e は `npm run e2e:master-chat-approval`（大半は偽 claude スタブ。最後の 2 チェックだけ実 claude で
  `--permission-prompt-tool` → `permission_prompt` → 制御 API の実配線を確かめる。`EBI_E2E_APPROVAL_REAL=0` で省ける）。
