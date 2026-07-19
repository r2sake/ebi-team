# ebi-team スマホアクセス対応プラン

> 目的: ebi-team の Web UI を、外出先（LAN 外含む）のスマホから安全に見て・触れて・操作できるようにする。
> 大前提: この UI は `claude` プロセスをフル操作できる（=マシン上で任意コマンド実行に近い権限を持つ）。**公開インターネットへの直曝露は絶対 NG**。到達経路は「本人のデバイスしか入れない閉域」に限定し、その上で**アプリ層の認証を必ず二重で被せる**（多層防御）。

---

## 1. 現状調査サマリ（コードの実態）

| 項目 | 現状 | スマホ対応への含意 |
| --- | --- | --- |
| bind 先 | `src/server/index.ts:39` `HOST = process.env.EBI_HOST ?? "127.0.0.1"`。既に env で変更可 | LAN/VPN bind はコード改修ほぼ不要。ただし `/control/*` も同一ポートで開くのが問題（下記） |
| HTTP + WS | `createServer` に `WebSocketServer({ server, path: "/ws" })` を相乗り（`index.ts:273,297`）。同一ポート `EBI_PORT`(既定8787) | bind を広げると **Web UI・WS・制御API が一括で同じ面に露出** |
| 制御API `/control/*` | `httpServer` 内で最優先処理（`index.ts:277`）。spawn/inject/kill/usage 等。認証なし・loopback 前提の設計コメントあり（`control.ts:1-9`） | **最重要リスク**: bind を広げると認証なしの制御APIが同じ面に出る。必ず認証で塞ぐ |
| クライアント WS URL | `main.ts:83-84` `${location.protocol==="https:"?"wss":"ws"}://${location.host}/ws`。**同一オリジン・自動 wss** | ホスト名対応は既に完了。https トンネル配下でも wss に自動切替。クライアント側の bind 改修は原則不要 |
| 認証 | **一切なし**（README も「ebi-team 自身は認証を持たない」と明記） | ゼロから最小認証を追加する必要あり |
| Vite dev | `vite.config.ts` 既に `host: true`（LAN 公開）+ `strictPort` + `/ws` proxy → `ws://localhost:8787` | dev では LAN 公開済み。ただし本番配信は Node 単一ポート。スマホ運用は基本 `npm start`（本番ビルド）想定 |
| UI レイアウト | `style.css:96` `grid-template-columns: 1fr 320px` 固定 2 カラム。`@media` クエリ無し。フォント 10–13px 中心 | **狭幅で崩れる**。サイドバー（registry/notice）が常時 320px を占有。モバイル用の縦積み/トグルが必要 |
| ターミナル | `pane.ts` xterm.js + FitAddon + ResizeObserver。`fontSize:12` | タッチスクロール・ソフトキーボード・ピンチズーム・小さすぎる文字が課題 |
| viewport meta | `index.html:5` `width=device-width, initial-scale=1.0` あり | 基本は入っている。ズーム抑制や safe-area は未対応 |

**結論**: 到達経路とアプリ層認証（＝制御APIを塞ぐ）が本丸。bind とホスト名対応はコード的にほぼ済んでいる。モバイル UI は「最小 CSS 対応」で Phase1、磨き込みを Phase2 に回せる。

---

## 2. 到達経路（reachability）の比較と推奨

| 方式 | 到達性(LAN外) | セキュリティ | 導入コスト | 常時稼働 | 評価 |
| --- | --- | --- | --- | --- | --- |
| **Tailscale（推奨）** | ◎ どこからでも | ◎ WireGuard の閉域。tailnet 内デバイスしか到達不能。ACL でポート/デバイス制限可。MagicDNS でホスト名固定 | ○ 両端にアプリ入れるだけ。ポート開放不要 | ◎ | **第一推奨** |
| Cloudflare Tunnel (+ Access) | ◎ | ○ 公開URL が生えるが Cloudflare Access(SSO/OTP) を必須にすれば閉域化。設定ミスで直曝露の事故余地 | △ トンネル+Access ポリシー設定 | ◎ | Tailscale が使えない時の次点。**Access 必須**（素の tunnel だけは NG） |
| LAN bind（`EBI_HOST=0.0.0.0`） | ✕ LAN内のみ | △ 同一 LAN の全端末に露出。外出先不可 | ◎ ほぼ即時 | ○ | **開発/宅内検証専用**。外出先要件を満たさない |
| ngrok 等の素トンネル | ◎ | ✕ 公開URLに直曝露。**この用途では不可** | ◎ | △ | **採用不可**（認証を足しても攻撃面が公開される） |

### 推奨: Tailscale + アプリ層トークン認証（多層防御）

- **経路**: 母艦（Mac）と スマホの両方に Tailscale を入れ、同一 tailnet に参加。スマホからは `http://<magicdns名>:8787`（例 `http://mac-mini:8787`）でアクセス。
- **bind**: `EBI_HOST` を **Tailscale インターフェースの IP（100.x.y.z）に限定** するのが最も安全（`0.0.0.0` にすると物理 LAN 側にも同時に開くため）。tailnet 経由のみ到達可能になる。
  - 実運用簡便版として `0.0.0.0` + OS ファイアウォールで tailscale0 のみ許可、でも可。**推奨は tailscale IP 直 bind**。
- **なぜ Tailscale か**: ポート開放・DNS・証明書運用が不要で、ネットワーク層で「本人のデバイスだけ」を保証できる。制御APIが露出しても tailnet の外からは物理的に到達不能。
- **多層防御**: それでも tailnet 内の別デバイス／将来の共有ミスに備え、**アプリ層のトークン認証を必ず併設**（次節）。ネットワーク層と アプリ層の二段で守る。

> HTTPS について: Tailscale 経由なら通信は WireGuard で暗号化されるため平文 HTTP でも経路上は保護される。ブラウザの `wss`/secure-context 要件が問題になる場合は Tailscale の `tailscale cert` / `serve` で TLS を付与可（Phase2 任意）。

---

## 3. 認証（最低限のトークン/パスワード）

### 要否: **必須**（bind を広げる＝制御API が同じ面に出る以上、アプリ層ゲートは省略不可）

### 実装方式（最小・推奨）: 共有シークレットのトークン認証

1. **サーバ側ゲート**: 環境変数 `EBI_AUTH_TOKEN`（未設定なら「loopback のみ許可・LAN/tunnel からは 401」＝安全側デフォルト）。
   - HTTP: `httpServer` の入口で全リクエストを検査（`/control/*` 到達前に前置）。Cookie `ebi_auth`（HttpOnly, SameSite=Lax）か `Authorization: Bearer` を照合。定数時間比較。
   - WS: `WebSocketServer` の `verifyClient`／`upgrade` で同じ Cookie/クエリを検査し、未認証はハンドシェイク拒否。**ここを塞がないと WS だけ素通りするので必須**。
   - 制御API `/control/*` は「loopback からは従来どおり無認証、非 loopback からはトークン必須」の二段判定にすると、master 仲介の内部呼び出し（127.0.0.1）を壊さずに外部だけ締められる。
2. **ログイン導線**: 最小の `/login`（トークン入力→Cookie セット）を1枚。スマホは一度入れれば Cookie 保持で再入力不要。
3. **ブルートフォース対策（軽め）**: 失敗回数のインメモリ・レート制限＋固定ディレイ。トークンは十分長いランダム（32byte）を README で案内。

> パスワードよりトークン推奨: ユーザー管理不要・単一オーナー運用・スマホで一度きりの入力で済むため。将来複数人化するなら Cloudflare Access（SSO）へ寄せる。

### 変更ファイル見込み（認証）
- 新規 `src/server/auth.ts`（トークン検査・loopback 判定・定数時間比較）
- `src/server/index.ts`（HTTP 入口前置・`wss` の verifyClient 追加・env 読み込み）
- `src/client/`（`/login` 用の最小 HTML/JS、または既存 index に未認証時リダイレクト）
- `README.md`（`EBI_AUTH_TOKEN` と Tailscale 手順の追記）

---

## 4. スマホ UI（xterm.js タイル UI のモバイル対応）

### Phase1 で最小限必要な変更
- **レスポンシブ CSS**: `style.css` に `@media (max-width: 768px)` を追加し、
  - `grid-template-columns: 1fr 320px` → 縦積み（`1fr` / サイドバーは下段 or ドロワー化）。
  - サイドバー（registry/notice）を**ハンバーガー/トグルで開閉**（狭幅では既定折りたたみ）。stage（選択ペイン）を全幅に。
  - タップ領域拡大（registry 行・spawn/kill/✕ ボタンを最低 44px）。フォント下限の底上げ。
- **ターミナル操作**:
  - ソフトキーボード表示のため、選択ペインをタップ→`term.focus()`（既存 `mousedown` フォーカスを touch でも発火）。
  - **入力補助バー**（Phase1 は簡易版）: Esc / Tab / ↑↓←→ / Ctrl など、スマホに無いキーを送る小さなボタン列。xterm へ制御シーケンス送出。
  - タッチスクロール: xterm の viewport をタッチでスクロールできるよう `touch-action` 調整。ピンチズーム誤爆抑止。
- **viewport 微調整**: `index.html` の meta に `viewport-fit=cover` と safe-area（ノッチ）対応の padding。二本指ズームは許容しつつ、フォーカス時の自動ズーム抑止（入力要素 `font-size >= 16px`）。
- **接続表示**: 縦画面で `#conn-status`/トップバーが潰れないよう折返し対応。

### Phase2（磨き込み）
- 入力補助バーの拡充（長押しでリピート、よく使うスラッシュコマンド、コピー/ペースト補助）。
- タイル一覧をスワイプで切替（registry ドロワー + ジェスチャ）。
- ダッシュボード/viewer のモバイル最適化（表の横スクロール、md ビューアの行間・フォント）。
- PWA 化（ホーム画面追加・全画面・向き固定の任意設定）。
- 画面回転・キーボード出現時の `refit()` 安定化（`visualViewport` イベント購読）。

### 変更ファイル見込み（UI）
- `src/client/style.css`（@media・ドロワー・タップ領域）
- `src/client/index.html`（viewport・入力補助バーの器・トグルボタン）
- `src/client/main.ts` / `src/client/pane.ts`（サイドバー開閉、touch フォーカス、入力補助バーのキー送出、`visualViewport` 追従）

---

## 5. WebSocket bind・ホスト名対応

- **bind**: WS は `httpServer` 相乗りのため、`EBI_HOST` を Tailscale IP にするだけで WS も追従（追加コード不要）。
- **ホスト名**: クライアントは既に `location.host` から同一オリジンで `ws`/`wss` を自動選択（`main.ts:83-84`）。**新規改修不要**。トンネルで https 化されても自動で `wss`。
- **CORS/Origin 検査**: WS ハンドシェイクで `Origin` を検査し、想定ホスト（tailnet の magicdns 名等）以外を弾く任意ガード（Phase2、DNS リバインディング対策）。
- **Vite dev**: 既に `host: true`。dev をスマホで使うなら proxy 先 `ws://localhost:8787` はそのままで可（同一マシン前提）。ただし**スマホ運用の本命は `npm start`（本番単一ポート）**。dev の LAN 公開時も認証ゲートを効かせること。

---

## 6. フェーズ構成

### Phase1 — 「最小で安全に使える」
到達経路確立 ＋ 認証 ＋ モバイルで破綻しない UI。

| 作業項目 | 変更ファイル見込み | リスク |
| --- | --- | --- |
| Tailscale 導入手順の整備（bind を tailscale IP に）＋ README | `README.md`, 運用手順のみ（コード最小） | tailscale IP は端末により変動 → MagicDNS 名で案内 |
| `EBI_AUTH_TOKEN` トークン認証（HTTP 前置 ＋ WS verifyClient ＋ 非loopbackの制御API必須化） | 新規 `src/server/auth.ts`, `src/server/index.ts` | WS 側の塞ぎ漏れ＝素通り。**verifyClient を必ずテスト**。loopback 判定の取り違えで master 内部呼びを壊さない |
| 最小 `/login`（Cookie セット） | `src/client`（1枚）, `index.ts` | Cookie 属性ミス（Secure/SameSite）。HTTP(平文)経路では Secure 付けられない点を Tailscale 前提で整理 |
| レスポンシブ CSS（縦積み・サイドバードロワー・タップ領域） | `src/client/style.css`, `index.html` | xterm の `fit()` が回転/キーボードで乱れる |
| 入力補助バー（Esc/Tab/矢印/Ctrl）簡易版 ＋ touch フォーカス | `src/client/pane.ts`, `main.ts`, `style.css` | 制御シーケンス送出の取りこぼし |
| 動作確認（実機スマホ ＋ Tailscale） | — | node-pty 本番ビルド前提。dev/prod 両経路の確認 |

**Phase1 完了条件**: 外出先のスマホから Tailscale 経由でログイン→エビ一覧が見え→選択ペインで入力/スクロールでき→未認証アクセスは HTTP/WS 双方で拒否される。

### Phase2 — 「磨き込み」
| 作業項目 | 変更ファイル見込み | リスク |
| --- | --- | --- |
| 入力補助バー拡充・スワイプ切替・コピペ補助 | `pane.ts`, `main.ts`, `style.css` | ジェスチャと xterm スクロールの競合 |
| `visualViewport` 追従で回転/キーボード時 refit 安定化 | `pane.ts` | 端末依存の挙動差 |
| Origin 検査（DNS リバインディング対策）・レート制限強化 | `auth.ts`, `index.ts` | 正規ホストの弾き過ぎ |
| Cloudflare Tunnel + Access 代替経路の手順（Tailscale 不可環境向け） | `README.md`, 設定のみ | Access 未設定での直曝露事故 → 手順で強制 |
| PWA 化（任意）・ダッシュボード/viewer のモバイル最適化 | `src/client/*` | スコープ肥大 |
| TLS 付与（`tailscale cert`/`serve`）で secure-context 完全化（任意） | 運用手順 | 証明書更新運用 |

---

## 7. 主要リスクと対策（まとめ）

1. **制御API の巻き添え露出（最重要）**: bind を広げると認証なしの `/control/*` が同じ面に出る。→ Phase1 のトークン認証で「非 loopback は必須」にし、Tailscale で経路自体を閉域化（二層）。
2. **WS の認証すり抜け**: HTTP だけ塞いで WS を忘れると素通り。→ `verifyClient`/upgrade で必ず検査、専用テストを追加。
3. **公開トンネルの誤用**: 素の ngrok/Cloudflare Tunnel だけは直曝露。→ 採用しない／Access 必須を手順で強制。
4. **平文 HTTP + Cookie**: Tailscale の WireGuard 暗号化に依存。ブラウザの secure-context 要件に当たる場合は Phase2 で TLS 付与。
5. **モバイル fit 崩れ**: 回転/ソフトキーボードで xterm が乱れる。→ Phase1 は基本対応、Phase2 で `visualViewport` 追従。
6. **既存挙動の破壊**: loopback 内部呼び（master 仲介）を認証で壊さない。→ loopback は無認証を維持する二段判定。

---

## 8. 推奨まとめ（TL;DR）
- **経路**: Tailscale（bind は tailscale IP 直）。次点は Cloudflare Tunnel + Access。素トンネル・LAN 直開放は不可。
- **認証**: `EBI_AUTH_TOKEN` の共有トークンを HTTP 前置 ＋ WS verifyClient ＋ 非loopbackの制御API必須化で被せる（未設定時は非loopback拒否の安全側デフォルト）。
- **クライアント**: WS の同一オリジン/自動 wss は既に実装済み。改修不要。
- **UI**: Phase1 でレスポンシブ CSS ＋ サイドバードロワー ＋ 入力補助バー（最小）。磨き込みは Phase2。
- **bind/WS**: `EBI_HOST` 変更で完結。コード改修はほぼ不要。
