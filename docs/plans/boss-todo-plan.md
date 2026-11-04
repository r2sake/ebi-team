# ボス TODO（やること一覧）機能のプラン

- 作成: 2026-11-04 engineer エビ（master 委譲 #1153・**プランのみ / 実装なし**）
- 置き場所: `docs/plans/`（既存の `*-plan.md` に合わせた）
- **r2: 2026-11-04 実装**（ボスの GO「推奨でok」＝ §7 の Q1〜Q5 はすべて推奨どおり。T1〜T3 を 1 ブランチ `feat/boss-todo` にまとめた）。
  実装で決めた細部: `todo_resolve` の `note` は使い道が無いので持たない／UI の回答は同一オリジンのブラウザの WS からだけ受ける
  （ファイル編集と同じ線引き）／同じ番号の回答の二重送信は 1 回だけ流す／回答の結果は `todoAnswerResult` で送った接続へ返す。
- ボスの要件（原文）:
  > ebi-teamにTODO管理機能を追加したい。
  > チャットログで裁定をやりとりすると流れて確認しづらい。
  > ・ワンクリックで質問の一覧が出る
  > ・回答したら消える
  > ・TODOの追加はmasterからのみ行う（ユーザの指示でTODOに追加等は可能）
  > ・基本的に備忘録ではなく、ユーザがebi-teamを使う上でしなきゃいけないこと（権限の許可や質問対応等）のみに使う
  > ・TODOの内容はmasterからも参照できるようにし、「TODOのN番について」だけでmasterから詳細を確認できる形にする

---

## 0. 結論

1. **新しいモジュール `src/server/todos.ts`（台帳 `TodoBoard`）を作る。** 保存先は `.ebi-team/todos.json`。書き込みは tmp に書いてから rename する（`viewers.json` と同じ流儀）。再起動しても消えない。
2. **番号は「通し番号で使い回さない」。** 次に振る番号 `nextNo` もファイルに保存する。#3 を消したあとに新しい TODO が来ても #3 にはならず、「N番」が別の TODO と混ざらない。
3. **master 専用の MCP ツールを 4 本足す:** `todo_add` / `todo_list` / `todo_get` / `todo_resolve`。master のブリッジ（`EBI_MCP_ROLE=master`）にだけ出す。追加できるのは master だけになる（今の spawn/kill と同じ線引き）。
4. **UI はトップバーに「📋 TODO n」ボタンを置く。** ワンクリックで一覧のパネルが開く。各行を押すと詳細・選択肢・推奨が出る。
5. **「回答したら消える」は両方の経路を用意する（推奨）。**
   - (a) UI で回答する: 選択肢か自由入力で送る。答えは `[TODO #N への回答] …` として master のチャットへ流し、その場で消す。
   - (b) チャットで回答する: master が `todo_resolve` で消す。
6. 作業は **3 便に分ける**（台帳＋MCP → UI → master への案内）。どの便も **ebi-team サーバの再起動が要る**ので、ボスの作業になる。

---

## 1. 今の作り（要点）

### 1.1 チャット UI
- 画面は `src/client/index.html`。トップバー（`header.topbar`）、ステージ（`#stage`）、右サイドバー（registry と notice）の 3 つでできている。
- master は `ui:"chat"` で動く（`ebi-team.config.json` の fixedEbi）。`#chat` の中を `src/client/chat.ts`（`ChatView`）が DOM で組み立てる。
  - ヘッダ（`chat-head`）: `💬 master`・状態・コストと文脈・📝（ファイル編集）・🆕（新しい会話）。
  - 下部: `chat-pending-bar`（未応答の承認・質問の件数。押すとその場所までスクロールする）と入力欄。
- 承認・質問のカードは今もある（PR-M5）。ただしトランスクリプトの中に出るので、**流れると探しにくい**。今回の不満の出どころはここ。

### 1.2 master と UI のやり取り
- WebSocket が 1 本ある。サーバからクライアントへは `chatEvent` / `chatSnapshot` / `chatState` / `viewers` / `registry` などを送る。
  接続した直後にもまとめて送る（`src/server/index.ts` の `wss.on("connection")`）。
- ボスの発話は WS の `chatSend` → `MasterSession.sendUserText()` → 頭脳プロセスの stdin（stream-json の user 1 行）へ流れる。
  master が busy でも stdin へ積まれる（キューで落ちない）。引用（`replyTo`）があると、本文の先頭に `> [reply to master#<seq>] …` が 1 行付く。
- エビの返信は `reply_to_master` → `/control/reverse-inject` → `MasterSession.deliverFromEbi()` の順に流れ、チャットに `inbound` として出る。
- 似た仕組みとして **`request_file_edit` がある**。master が依頼すると、チャットにカードが出てすぐ返る。ボスが保存するか見送ると、`[file-edit <id>] …` が master へ通知される。
  ただし台帳（`FileEditRequests`）は**メモリだけ**で、再起動すると消える。

### 1.3 ebi-control の MCP ツールの足し方
1. `src/mcp/control-server.ts` の `if (ROLE === "master") { … }` の中で `server.tool(name, 説明, zodスキーマ, handler)` を呼ぶ。handler は `callControl()` で制御 API を叩く。
2. `src/server/control.ts` の `createControlApi` に `pathname === "/control/xxx"` の分岐を足す。中身は `ControlDeps` に関数を 1 本足し、`index.ts` で配線する（DI）。
3. 制御 API は 127.0.0.1 に限られていて、**呼び出し元ごとの認証は無い**。master だけに使わせるのは「MCP のツールを master ティアにしか出さない」ことで担保している（spawn/kill も同じ）。
4. ブリッジは master の頭脳プロセスが `dist/mcp/control-server.js` として起動する。ツールを足したら **`npm run build` をやり直して、サーバを再起動する**必要がある。サーバ側のエンドポイントも `dist` で動いているため。

### 1.4 状態の保存先
- `<cwd>/.ebi-team/` の下に置いている（gitignore 済み）。主なもの: `registry.json`・`viewers.json`（rename で書く）・`master-chat.jsonl`（会話。追記とローテート）・`file-edits.jsonl`（監査）・`usage-history.jsonl`。
- パスはどれも env で差し替えられる（例: `EBI_VIEWERS_PATH`）。テストでは一時ディレクトリを渡す。

---

## 2. TODO の持ち方

### 2.1 項目

```ts
type TodoKind = "question" | "permission" | "action";   // 質問 / 権限の許可 / 作業（ボスの手作業）

interface TodoOption { label: string; description?: string }

interface TodoItem {
  no: number;              // 通し番号（「N番」）。使い回さない
  title: string;           // 件名（1 行・〜80 字）
  detail: string;          // 詳細（Markdown・〜4000 字）。背景・判断材料・影響
  kind: TodoKind;
  ebi: string | null;      // どのエビか（例 "engineer-3"）。無ければ null
  project: string | null;  // どの案件か（例 "kakeba" "VC 王冠"）。自由文字列
  options: TodoOption[];   // 選択肢（0〜6 件。質問以外は空でよい）
  recommended: string | null; // 推奨する選択肢の label（options にあるものに限る）
  createdAt: number;       // 作った時刻（epoch ms）
}

interface TodoFile { version: 1; nextNo: number; items: TodoItem[] }
```

- 入力の検証はサーバ側（`TodoBoard.add`）でする。長さで切る・制御文字を落とす・kind を enum で確かめる・recommended が options にあるか確かめる。
- 作った人（createdBy）は持たない。master しか作れないので意味が無い。

### 2.2 番号の振り方（「N番」が混ざらないか）
- `nextNo` を `todos.json` に保存し、`add` するたびに 1 ずつ増やす。**消しても戻さない**。再起動しても続きから振る。
  そのため「#3 を解決 → 新しい TODO」は #4 以降になり、ボスが覚えている「3番」と別物にはならない。
- 「新しい会話」（🆕）を押しても番号はリセットしない。TODO は会話ではなくチーム全体の台帳として持つ。
- 消えた番号を `todo_get` で引いたら、「#N は無い（解決済みか、存在しない番号）」を返す。
  解決済みか未発行かまで区別するなら `nextNo` と比べるだけで足りる（N < nextNo なら「解決済み」）。履歴は持たなくてよい。
- `todos.json` が壊れていても起動は止めない（fail-soft）。壊れたファイルは `todos.json.broken-<ts>` へ退避し、warn を出して空の台帳・`nextNo = 1` で始める。
  このときだけ過去の番号と重なりうる。atomic 書き込みなので普通は起きない。§5 の論点 4 に挙げた。

### 2.3 保存先と再起動
- `.ebi-team/todos.json`（env `EBI_TODOS_PATH` で差し替えられる）。変わるたびに tmp へ書いて rename する。書き込みは直列化する。
- 起動時に `restore()` で読む。再起動しても消えない。

---

## 3. master 側の MCP ツール（master ティアだけ）

| ツール | 引数 | 返り値 | 制御 API |
|---|---|---|---|
| `todo_add` | `title, detail, kind, ebi?, project?, options?, recommended?` | `{ no }` | `POST /control/todo-add` |
| `todo_list` | なし | 未解決の一覧（`no / kind / title / ebi / project / createdAt` だけ。詳細は含めない＝トークン節約） | `GET /control/todos` |
| `todo_get` | `no` | 1 件の全部（detail・options・recommended まで）。無ければ「解決済み or 未発行」 | `GET /control/todo?no=N` |
| `todo_resolve` | `no` | `{ ok }`。台帳から消し、UI の一覧から即座に消える | `POST /control/todo-resolve` |

- **追加は master だけ**。ツールは `ROLE === "master"` のブロックにだけ置き、engineer ティアには出さない。UI にも「追加」ボタンは作らない。
  ボスが「これ TODO に入れといて」と言った場合も、master が `todo_add` を呼ぶ。
- 制御 API を直接叩けば誰でも追加できてしまう。ただし spawn/kill も同じ状態で、今のつくりの線引き（127.0.0.1 限定＋MCP ティア）をそのまま使う。強める案は §8 の提案に回した。
- ツールの説明文に**使い方の決まり**を書く。要件にある「備忘録ではない」を master に守らせるため:
  - 「ボスが ebi-team を使う上でやらなければならないこと（質問への回答・権限の許可・ボスの手作業）だけを入れる。メモ・備忘・進捗の記録には使わない」
  - 「ボスが『TODO の N 番』と言ったら `todo_get(N)` で詳細を確かめてから話す」
  - 「ボスがチャットで答えたら、その答えで動く前に `todo_resolve(N)` で消す」
- この決まりは master ティアの MCP `instructions` にも同じ文を載せる。今は engineer ティアにだけ instructions があるので、master ティア用を足す。
  master のシステムプロンプトは `ebi-team.config.json` にあり gitignore 済み（コードで直せない）ため、こちらに寄せる。

---

## 4. UI

### 4.1 ワンクリックで一覧を開く場所
- **推奨: トップバーの `h1` の右に「📋 TODO <件数>」ボタンを置く。**
  - トップバーはどのペイン（エンジニアの PTY・ダッシュボード・viewer）を見ていても出ている。チャットを開いていなくても一押しで届く。
  - 件数は 0 のときは薄い色で「📋 0」と出す。1 以上なら強調色のバッジを付ける。種類ごとの内訳はボタンの title に出す（例「質問 2・許可 1」）。
  - 狭い幅（スマホ）でもトップバーのボタンは残す。今は spawn 系の入力が隠れて h1 とトグルだけが残るので、その並びに入れる。
- 別の案: チャットのヘッダ（📝 の隣）に置く。チャットを見ていないときは届かないので推奨しない。

### 4.2 一覧と詳細の見せ方
- ボタンを押すと、**右から出るパネル**（狭い幅では全画面のシート）が開く。中身は `src/client/todoPanel.ts` が新しく組み立てる。`fileEditor` のダイアログと同じく、`index.html` に空の `<div id="todo-panel" hidden>` を置く。
- 一覧の 1 行: `#12`・種類のアイコン（❓ 質問／🔐 許可／🛠 作業）・件名・`engineer-3 / kakeba`・経過時間（「5 分前」）。並びは古い順にする（待たせている順）。
- 行を押すと、その場で開いて詳細を出す（アコーディオン）:
  - 詳細は今の `markdown.ts` で描く（チャットと同じ見た目・同じサニタイズ）。
  - 選択肢をボタンで並べ、推奨のものに「推奨」バッジを付ける。続けて自由入力欄を置き、「回答して送る」ボタンを置く。
  - 選択肢が無い作業や許可には「✓ 対応した」ボタンを出す（任意で一言を添えられる）。
- 一覧はサーバからの WS `todos`（全件のスナップショット）で描く。接続した直後と、変わるたびに全クライアントへ配る（`viewers` と同じやり方）。

### 4.3 「回答したら消える」の流れ
- **推奨: 両方の経路を用意する。**
  - **(a) UI から回答する**: WS `todoAnswer {no, choice?, text?}` を送る。サーバは台帳から #N を消し、master へ本文 `[TODO #12 への回答] 選択: B / 補足: …` を `sendUserText` で流す。
    ボスの発話としてチャットにも残る。master には「TODO #12 の答え」が本文だけで伝わる。
    「✓ 対応した」のときは `[TODO #12 対応済み] …` になる。
  - **(b) チャットで回答する**: ボスが「12 番は B で」とチャットに書く。master が `todo_resolve(12)` で消す。
- 両方にする理由: (a) だけだと、ボスが勢いでチャットに書いたときに TODO が残る。(b) だけだと、一覧を開いたのに答えられず、ワンクリックで済まない。
- 消すのは「回答した瞬間」にする。master が受け取ったかどうかは待たない。
  `sendUserText` が `accepted:false`（master が止まっている）を返したときだけ消さずに残し、パネルにエラーを出す。答えが宙に浮かないようにするため。
- master が PTY（`ui:"chat"` でない）構成のとき、(a) の送り先は master への `inject` に切り替える。今の構成は chat なので、この経路は試験だけにする。

---

## 5. 論点（足さずに挙げるだけ）

1. **消したものを後から見たいか（履歴）。** 要件は「回答したら消える」なので足さない。
   後で必要になったら、`.ebi-team/todo-log.jsonl` に「作った・解決した（答えの要約）」を追記するだけで足りる（`file-edits.jsonl` と同じ流儀）。UI に「解決済み」タブを作るのはその次の話。
   なお、UI で答えたものはチャットログに `[TODO #N への回答]` として残るので、何も足さなくても追える。
2. **master の承認カード（permission_prompt）を自動で TODO に載せるか。** 要件は「追加は master からのみ」なので載せない。
   承認カードは今の `chat-pending-bar` に件数が出る。
3. **TODO が残ったまま古くなる問題。** 例: エビが kill されて質問が無意味になった。自動では消さない。master が `todo_list` を見て `todo_resolve` で片付ける運用にする。
4. **`todos.json` が壊れたときの番号の保証**（§2.2）。今回は「退避して 1 から」とする。完全に保証するなら、番号を別ファイルに持つか、退避したファイルから最大の no を拾う手がある。やりすぎと判断した。

---

## 6. 作業の分け方・テスト・再起動

### 6.1 便
| 便 | 中身 | 主なファイル |
|---|---|---|
| **T1 台帳＋MCP** | `TodoBoard`（add / list / get / resolve / restore・atomic 保存・nextNo）、制御 API 4 本、master ティアの MCP 4 ツールと instructions、WS `todos` の配信（UI はまだ無い） | `src/server/todos.ts`（新規）・`control.ts`・`index.ts`・`src/mcp/control-server.ts`・`src/shared/protocol.ts` |
| **T2 UI** | トップバーのボタンと件数、パネル（一覧・詳細・選択肢・推奨・自由入力・✓ 対応した）、WS `todoAnswer` / `todoDone` とサーバ側の処理（消す＋master へ `[TODO #N …]` を流す） | `index.html`・`src/client/todoPanel.ts`（新規）・`main.ts`・`style.css`・`index.ts` |
| **T3 案内と仕上げ** | ツールの説明文の調整、README に一節、e2e | `README.md`・`scripts/e2e-todo.mjs`（新規） |

T1 だけでも master は「N番」を答えられる（UI が無いあいだはチャットに一覧を出すだけ）。T2 で要件の「ワンクリック」と「消える」がそろう。T3 は T2 と一緒に入れてもよい。

### 6.2 テストの方針
- **ユニット（`node --test`、`test/todos.test.ts`）**: 番号を使い回さないこと（追加 → 解決 → 追加で番号が増えるか）、再起動したときの復元（新しいインスタンスで同じ no と nextNo になるか）、atomic 書き込み（tmp が残らないか）、壊れた JSON でも throw しないか、入力の検証（kind の enum・長さの上限・recommended が options にあるか）、無い番号を引いたときに「解決済み／未発行」を返し分けるか。
  `viewerPersistence.test.ts` と同じく一時ディレクトリを使う。
- **ユニット（制御 API）**: `createControlApi` に fake の deps を渡し、4 エンドポイントの 200・400・404 を確かめる。
- **ユニット（MCP ティア）**: engineer ティアのブリッジに `todo_*` が**出ない**ことを確かめる（要件「追加は master だけ」の回帰を防ぐ）。
- **ユニット（UI の純関数）**: 回答の本文の組み立て（`[TODO #N への回答] 選択: … / 補足: …`）と件数バッジの文言を純関数に切り出して試す（`masterChatUi.test.ts` と同じ流儀）。
- **e2e（`scripts/e2e-todo.mjs`）**: 使い捨てのポートと `EBI_TODOS_PATH` で起動したサーバに対して、`todo_add` → WS `todos` に載る → `todoAnswer` → 台帳から消え、master 宛てに本文が届く、を確かめる。**本番のサーバ（npm start）には触れない。**

### 6.3 サーバの再起動（ボスの作業）
- **要る。** 理由は 2 つ。制御 API・WS・台帳はサーバのプロセス（`dist/server`）にある。MCP ツールはブリッジ（`dist/mcp`）にあり、master の頭脳プロセスが起動したときに読み込む。
- 手順は便ごとに「`npm run build` → ボスが `npm start` を再起動」。再起動すると master の頭脳も起動し直し、`--resume` で会話の続きに戻る。
- エビ（engineer）側は何も変わらないので、動いているエビの作り直しは要らない。

---

## 7. ボスに決めてもらうこと（推奨つき）

| # | 決めること | 推奨 | ほかの案 |
|---|---|---|---|
| Q1 | 回答の経路 | **UI とチャットの両方**（§4.3） | UI だけ／チャットだけ |
| Q2 | ボタンの場所 | **トップバー**（どのペインからでも一押しで届く） | チャットのヘッダ |
| Q3 | 種類の分け方 | **質問／権限の許可／作業 の 3 つ** | 「その他」を足して 4 つ |
| Q4 | 「新しい会話」で番号をリセットするか | **しない**（通し番号のまま） | 会話ごとに 1 から（「N番」が混ざる危険がある） |
| Q5 | 履歴（§5-1） | **今は足さない**（チャットログで追える） | 解決の記録だけ jsonl に残す |

---

## 8. 提案（要件の外。入れるならボスの GO のあとに別便で）

- **「そのエビを開く」ボタン**: 詳細の `ebi` が registry に居るなら、押すとそのペインへ切り替える。権限の許可で PTY のエビへ飛ぶ手間が省ける。
- **TODO の番号からチャットの元発言へ飛ぶ**: `todo_add` のときのチャット seq を持たせ、詳細から引用元へジャンプする（既存の `chat-reply-jump` を流用できる）。
- **追加の通知**: TODO が増えたらトップバーのボタンを一瞬光らせる。スマホではプッシュ通知に載せる。
- **制御 API で呼び出し元を確かめる**: `/control/todo-add` を master のブリッジだけが知るトークンで守る。spawn/kill も含めた横断の改善なので、TODO 単独ではやらない。
