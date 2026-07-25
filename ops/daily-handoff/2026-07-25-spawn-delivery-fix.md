# 引き継ぎ: spawn 直後のタスク本文消失の根治（2026-07-25）

対象ブランチ: `feat/master-channel-receive`（作業ブランチ `fix/spawn-delivery-loss` をマージ済み）
状態: **build 済み・サーバ再起動待ち**（再起動はボスが実行。`npm start` の dist は起動時ロード）

## 1. 何が壊れていて、何を直したか

### 症状（2026-07-24〜25 に 6 件以上）

`send_message(spawnIfMissing:true, message:<長文タスク>)` で新規 spawn したエビに **タスク本文が届かず空プロンプトで放置**される。既に起動済みのエビへの再送は 100% 成功。失敗時の scrollback は Claude Code の初期画面＋空の入力欄で、本文の痕跡がゼロ。非決定的でモデル不問。

### 根因（live e2e で機械実証）

**到達確認が「ブリッジ到達」止まりで「セッション到達」を見ていなかった。**

1. spawn 直後、制御MCP ブリッジ（`src/mcp/control-server.ts`）は claude 本体とは別プロセスとして数百 ms で立ち上がり `/control/subscribe` を張る。
2. 一方 claude セッション本体は起動ゲート（dev-channels 警告 / workspace trust ダイアログ）で止まっており、**まだ `ebi-control` を channel として登録し終えていない**。
3. この窓で notification を push すると、harness は `notifications/claude/channel` を**黙って捨てる**。失敗セッションの TUI にはその痕跡が出る:
   ```
   ▎server:ebi-control · no MCP server configured with that name
   ```
4. しかしブリッジは `server.notification()` を stdout へ書いた**直後**に ACK を返すため、`registry.deliver()` は `via:"notify" / confirmed:true` と誤判定し、**PTY フォールバックが発動しないまま本文が消える**。

成功時は同じ位置に `❯ ←ebi-control: [from:master] #タスク2（到達計測用…` と本文プレフィクスが描画される。この描画の有無が「セッションに届いたか」の唯一の観測点。

### 修正（4 点）

| # | ファイル | 内容 |
|---|---|---|
| 1 | `src/server/agent.ts` | 起動ゲート自動応答が有効なエビは **dev-channels ゲート応答が済むまで ready に昇格させない**（ダイアログ待ちの沈黙→idle→ready 誤昇格を封じる）。`EBI_GATE_SETTLE_MS`（既定 20s）で degrade する保険つき |
| 2 | `src/server/index.ts` | `sendMessage` は **spawn 直後だけ ready 成立を待ってから配送経路を選ぶ**。ready timeout でも配送は継続する（後段の到達確認＋フォールバックが担保するため、本文を捨てる方が害が大きい） |
| 3 | `src/server/registry.ts` + `agent.ts` | `deliver()` は ACK の後に **セッション到達（本文エコー）を scrollback で確認**し、取れなければ PTY 注入へフォールバック（at-least-once 化） |
| 4 | `src/server/control.ts` + `index.ts` | `/control/send` が `via`（`notify` / `pty-fallback` / `pty`）を返す（可観測性・e2e 判定用） |

エコー確認の設計上のポイント:

- 照合は **push 以降に出力された scrollback だけ**を見る（`Agent.scrollbackMark()` / `scrollbackSince()`）。過去の同種メッセージの描画を到達と誤認しない。
- 照合は **compact（ANSI・空白を全除去）同士の前方一致**（`containsEcho` / `echoNeedle`）。TUI が空白を潰し先頭を切り詰めて描画する罠に対応。
- **一度到達を確認できたエビは以降スキップ**（`channelProven`）。既存セッションへの再送は元々取りこぼしが無く、毎回待つのは遅延と重複配送のリスクにしかならない。
- 照合対象は**制御MCP ブリッジ持ち（＝claude）のみ**。bash 等のテスト起動は channel 描画が原理上出ないため対象外。

環境変数:
- `EBI_ECHO_CONFIRM_MS`（既定 8000）… エコー確認の待ち上限。**0 以下にすると確認を無効化＝旧挙動へロールバック**
- `EBI_ECHO_NEEDLE_LEN`（既定 24）… 照合する本文先頭の長さ（compact 後の文字数）
- `EBI_GATE_SETTLE_MS`（既定 20000）… ゲート応答待ちの degrade 上限

## 2. 検証結果

- unit: **74/74 緑**（既存 66 ＋ 新規 8）
  - `test/gate.test.ts`: `containsEcho` / `echoNeedle` の純関数 5 件（失敗ラウンドの実 scrollback を固定値で回帰）
  - `test/delivery.test.ts`: ACK あり・エコー無し→`pty-fallback` / ACK＋エコー→`notify`＋`channelProven` / 過去描画の誤認防止 の 3 件
- live e2e（新規 `scripts/e2e-spawn-delivery.mjs`・実 claude を spawn）
  - **修正前: 到達 4/6**（33% 消失を再現）
  - **修正後: 到達 6/6**。うち 2 件は「ACK されたがセッション到達を確認できず PTY 注入へフォールバック」のログどおり、旧実装なら消えていた本文がフォールバックで届いた
  - **受け入れ基準の 20 連続: 20/20（100%）**
- 既存 live e2e（`scripts/e2e-master-channel.mjs` 等）の回帰も確認済み

### 再現テストの重要な注意（今後ハマらないために）

`scripts/e2e-spawn-delivery.mjs` は制御MCP ブリッジを **本番と同じ `node dist/...` で起動する**。これが再現の肝。既存 e2e は `npx tsx` 起動でブリッジ立ち上がりが 2〜3 秒遅く、その間にサーバの起動ゲート自動応答がダイアログを越えてしまうため「購読確立が常にダイアログ突破の後」になり、**このレースが構造的に再現しなかった**。`EBI_E2E_MCP_MODE=tsx` で旧挙動に切り替えられるが、既定（dist）で回すこと。

```
# 既定 5 ラウンド・並列 2
node scripts/e2e-spawn-delivery.mjs
# 受け入れ基準の再実行
EBI_E2E_ROUNDS=20 EBI_E2E_CONCURRENCY=4 node scripts/e2e-spawn-delivery.mjs
```

専用ポート 8801 ＋ mkdtemp で完結し、本番 8787 には触らない。判定用エビは haiku 固定のカスタム役割 `echobot`（使い捨て config 内で定義）。

## 3. 再起動後にやること

1. サーバ再起動（`npm start`。手順は 2026-07-22 の handoff R2-1）
2. 受け入れ確認: テストエビを `send_message(spawnIfMissing:true)` で spawn し、**本文到達 → reply 到達**を見る
3. 同時に有効化される積み残し: **engineer 既定モデルの Opus 5 化**（commit `b0a0cb7`・build 済み）。反映後、テストエビの既定が `claude-opus-5` になったことを確認し、自動メモリ `engineer-ebi-default-opus5` の「spawn 時に model 明示」運用を解除する
4. 暫定運用（タスク冒頭に「受信できたら『本文受信OK』と reply せよ」を入れる／5 分 ACK 未着なら read_scrollback して再送）は、上記受け入れ確認が通れば**解除してよい**。ただし配送経路は `/control/send` の `via` で観測できるので、`pty-fallback` が常態化していないかは時々見ること（常態化＝channel 登録が恒常的に遅い or 壊れているサイン）

## 4. 未着手・提案（実装していない）

指示書 §2 の積み残しは今回のスコープ外として手を付けていない:

- **AskUserQuestion の回答が master に届かない**（優先度: 中）
- **スマホでログスクロール不可**（優先度: 中）

作業中に気づいた点（実装せず提案のみ）:

- `deliver()` の PTY フォールバックは「多少の重複は許容」の方針。エコー確認が偽陰性を出すと channel と PTY の二重配送になりうる。今回の実測では発生しなかったが、`EBI_ECHO_CONFIRM_MS` を短くしすぎると増える。
- 失敗時の TUI に出る `no MCP server configured with that name` は明示的な負のシグナルなので、これを検知したら即フォールバック（8s 待たない）という高速化余地がある。harness の文言に依存するため今回は採用しなかった。
