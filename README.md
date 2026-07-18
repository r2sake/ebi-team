# 🦐 ebi-team

Claude Code CLI の上に複数のエージェント（本プロジェクトでは「エビ」と呼びます）をオーケストレーションし、localhost の Web UI から一括で見て・触れて・操作できるようにする開発支援ツールです。

各エビは `claude` プロセスを [node-pty](https://github.com/microsoft/node-pty) で直接 spawn したもので、ブラウザ上の xterm.js タイルへ PTY 出力をそのままストリームします。宣言的な設定ファイルで常駐エージェント（例: 統括役・作業役）を定義でき、エージェント同士のメッセージのやり取りは MCP 経由の制御ツールで行います。tmux 等には依存しない、シンプルな構成です。

> **English (optional):** ebi-team orchestrates multiple Claude Code CLI sessions ("ebi") from a single localhost web UI. Each session is a `claude` process spawned directly via node-pty and streamed to an xterm.js tile in the browser. Fixed agents (e.g. a coordinator and worker roles) are declared in a config file, and agents can message each other through MCP control tools.

---

## Requirements

- **Node.js 20 以上**
- **Claude Code CLI** がインストール済みで、`claude login` によるログインが完了していること（Claude のサブスクリプションアカウントで動作します。API キーは不要です）
- **macOS または Linux**（`node-pty` がネイティブ依存のためです。現状 macOS での動作実績があります。Linux は未検証のため、環境によっては追加のビルド対応が必要になる可能性があります）

---

## Quick Start

```bash
git clone <このリポジトリのURL>
cd ebi-team

npm install
# 初回は node-pty のネイティブビルド等が走るため、数分かかることがあります

cp ebi-team.config.example.json ebi-team.config.json
# 自分用の人格・エージェント構成をここに書きます（後述）

npm run dev
```

ブラウザで **http://localhost:5173** を開くと Web UI が表示されます。

別ディレクトリを作業対象にしたい場合は、環境変数でエビの既定 cwd を指定できます。

```bash
EBI_DEFAULT_CWD=/path/to/your/project npm run dev
```

### 本番ビルドで動かす場合

```bash
npm run build
npm start      # http://localhost:8787 で配信（WebSocket も同一ポート）
```

### その他の主なコマンド

```bash
npm run typecheck   # サーバ/フロント双方の型チェック
```

---

## Configuration

固定で常駐させたいエージェント（統括役・専門役など）は、リポジトリ直下の `ebi-team.config.json` で宣言します。このファイルは `.gitignore` 対象なので、公開リポジトリ側を `git pull` して更新しても自分の設定と衝突しません。各自の環境に合わせて自由に育てていく前提の拡張ポイントです。

まずはテンプレートをコピーして使います。

```bash
cp ebi-team.config.example.json ebi-team.config.json
```

`fixedEbi` 配列に、起動時に自動 spawn したいエージェントを列挙します。

```jsonc
{
  "fixedEbi": [
    {
      "id": "coordinator",
      "kind": "master",
      "cwd": ".",
      "model": "opus",
      "permissionMode": "acceptEdits",
      "args": ["--strict-mcp-config"],
      "appendSystemPrompt": "あなたはこのプロジェクトの統括エージェントです。…"
    }
  ]
}
```

主なフィールド:

| フィールド | 説明 |
| --- | --- |
| `id` | エージェントの識別子 |
| `kind` | 種別（統括役 / 作業役など。役割ごとに削除可否や既定モデルが変わります） |
| `cwd` | 作業ディレクトリ（`$HOME` や `~`、環境変数展開に対応） |
| `model` | 起動モデル（`opus` / `sonnet` / `haiku` など） |
| `permissionMode` | Claude Code の権限モード（`acceptEdits` など） |
| `args` | 追加の起動引数 |
| `appendSystemPrompt` | **ここが人格・カスタムロールの定義点です。** そのエージェントの性格や役割、振る舞いのルールをシステムプロンプトとして注入します |

つまり、コード側は誰にとっても同じ「箱」のままにしておき、**自分らしいエージェントの人格や役割分担は `ebi-team.config.json` の `appendSystemPrompt` に書く**、という運用を想定しています。

### カスタム役割 (custom roles)

動的エビ（`spawn_ebi` / `send_message` で都度起動する作業役）には既定で `engineer` 役割だけが同梱されています。`ebi-team.config.json` の top-level `roles` に定義を追加すると、**コードを一切触らずに** 自分専用の役割（例: レビュー専任、ドキュメント専任など）を増やせます。追加した役割は起動時に読み込まれ、`spawn_ebi` / `send_message` の `role` にその id を指定して使えます。

```jsonc
{
  "roles": {
    "reviewer": {
      "label": "レビュアー",
      "emoji": "🔍",
      "mcpRole": "engineer",
      "permissionMode": "default",
      "defaultModel": "sonnet",
      "appendSystemPrompt": "あなたはコードレビュー専任の使い捨てセッション。…"
    }
  }
}
```

フィールドはすべて省略可です。

| フィールド | 説明 | 省略時の既定 |
| --- | --- | --- |
| `label` | UI 表示名 | 役割 id と同じ |
| `emoji` | UI バッジ絵文字 | `🧩` |
| `mcpRole` | 動的エビに与える MCP 権限ティア。**`"engineer"` のみ許容**（動的エビが持つ唯一の最小権限ティアで、他エビの spawn/kill/操作はできません） | `"engineer"` |
| `permissionMode` | Claude Code の権限モード | サーバの既定値 |
| `defaultModel` | 起動モデル（`opus` / `sonnet` / `haiku` など） | `"sonnet"` |
| `appendSystemPrompt` | その役割の人格・振る舞いのルールを注入するシステムプロンプト | 空（注入なし） |

組込みの `engineer` は同名キーで上書きできますが、削除はできません（`roles` は既存レジストリへの追加/上書きのみです）。

### md/txt ビューア (viewer)

統括役（master）がレビュー用のプランやレポート（md/txt）を UI に「見せる」ための **読み取り専用ビューア**です。master 専用の MCP ツール `open_viewer({ path, title? })` で開くと、REGISTRY サイドバーに `📄 <タイトル>` 行が現れ、メイン領域にプレビューが表示されます（開いた瞬間は自動でそのビューアに切り替わります）。行またはパネルヘッダの `✕` で閉じます。

- **レンダリング**: 外部ライブラリを使わない依存ゼロの軽量レンダラで、見出し・箇条書き/番号リスト・コードブロック・インライン code・bold/italic・引用・水平線・表・リンクを描画します（`.txt` は等幅の生テキスト）。
- **安全性**: 生成は `createElement` / `textContent` のみで行い、`innerHTML` に生コンテンツを入れません。md 中に含まれる HTML タグ（`<script>` 等）は文字列として表示され、実行されません。
- **アクセス範囲**: 開けるのは許可ルート配下の `.md` / `.markdown` / `.txt` のみ（読み取り専用・サイズ上限あり・シンボリックリンクの脱出は `realpath` で防止）。許可ルートは環境変数 `EBI_VIEWER_ROOTS`（`:` 区切り・未設定時の既定は `$HOME/workspace`）で設定します。上限は `EBI_VIEWER_MAX_BYTES`（既定 1MB）。

### spawn 後の表示切り替え

エビを spawn しても表示は自動で新しいエビに切り替わりません（既定 OFF）。統括役（master）などに向けて打っている入力が、直近に起動したエビへ誤って送られる事故を防ぐためです。ヘッダの「spawn後に移動」チェックボックスを ON にすると、spawn したエビへ自動でフォーカスする従来挙動になります（設定はブラウザに記憶されます）。REGISTRY 行の手動クリックでの切り替えは常に有効です。

---

## How it works / Architecture

構成要素は大きく 2 プロセスです。

- **Node サーバ（既定ポート 8787）**: WebSocket サーバ・ローカル専用の制御 API・各エージェントのライフサイクル管理を担当します。`claude` を子プロセスとして `node-pty` で spawn し、PTY の入出力をそのままブラウザへ中継します。
- **Vite フロントエンド（既定ポート 5173）**: xterm.js ベースのタイル UI。dev 時は Vite が `/ws` をサーバへ proxy します。

```
ブラウザ (xterm.js タイル, :5173)
   │  WebSocket
   ▼
Node サーバ (:8787)
   │  node-pty で spawn
   ▼
claude プロセス（エージェント本体）
```

- **認証**: `claude` CLI 自体のログイン状態（`claude login` によるサブスクアカウントの認証）に依存します。ebi-team 自身は API キーを持たず、扱いません。
- **エージェント間の制御**: MCP（Model Context Protocol）ベースの制御サーバを介して、エージェント同士がメッセージを送り合ったり、他のエージェントを起動・監視したりできます。ローカル専用の HTTP 制御 API（127.0.0.1 限定）がその土台です。

---

## Extending / 自分用にカスタマイズ

- **公開版のコードを source of truth とする**ことを前提にしています。自分ならではの拡張は、gitignore された `ebi-team.config.json`（人格・役割・常駐エージェント構成）に閉じ込めるのが基本方針です。
- 設定ファイルだけでは足りず、コード自体に手を入れたい拡張が必要になった場合は、fork した上で upstream の更新を追従してください。

---

## License

MIT
