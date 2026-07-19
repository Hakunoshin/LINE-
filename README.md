# personal-line-agent

自分専用のLINEリマインダー/タスク管理エージェント。Cloudflare Workers + D1 + LINE Messaging APIで動きます。

## できること

LINEでトークを送るだけでリマインダーを登録・確認・削除できます。指定した日時になると Cron Trigger が1分ごとにチェックし、LINEへプッシュ通知します。

```
追加 明日9:00 ゴミ出し
一覧
削除 3
今日
ヘルプ
```

日時の指定は以下のような形式に対応しています。

- `今日` / `明日` / `明後日` + `HH:MM` または `H時M分`
- `YYYY-MM-DD HH:MM`
- `M/D HH:MM`（年省略時は現在の年、過ぎていれば翌年扱い）
- 時刻を省略した場合は 9:00 扱いになります

### Google連携（任意）

Googleアカウントと連携すると、以下が使えるようになります。

- **毎日ダイジェスト**: 毎日決まったJST時刻（デフォルト08:00、`DAILY_DIGEST_TIME_JST`で変更可）に、
  Googleカレンダーの今日の予定 と Google Tasksの未完了ToDo をまとめてLINEへ自動プッシュ通知
- **`今日` コマンド**: 上記と同じ内容をいつでも手動で取得
- **`追加` コマンドの自動反映**: LINEで追加したリマインダーをGoogle Tasksのデフォルトリストにも自動登録
  （Google Tasksは時刻指定ができないため、タイトルに `[HH:MM]` を付与して登録します）

カレンダーは読み取りのみ、ToDoはGoogle Tasksとの読み書きです（カレンダーへの書き込みは行いません）。

## セットアップ

### 1. LINE Developersでチャネルを作成

1. [LINE Developers Console](https://developers.line.biz/console/) にログイン
2. 新規プロバイダー作成 → **Messaging API** チャネルを作成
3. チャネル基本設定から **Channel secret** を控える
4. Messaging API設定タブから **Channel access token (long-lived)** を発行して控える
5. Webhookの利用を **オン** にする（URLは後述のデプロイ後に設定）
6. 応答メッセージ（自動応答/あいさつメッセージ）は **オフ** にしておく

### 2. D1データベースを作成

```bash
npx wrangler d1 create personal-line-agent-db
```

出力された `database_id` を `wrangler.toml` の `REPLACE_WITH_YOUR_D1_DATABASE_ID` に反映してください。

```bash
npm run db:migrate:local   # ローカル動作確認用
npm run db:migrate:remote  # 本番反映
```

### 3. LINEのSecretsを設定してデプロイ

```bash
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET

npm install
npm run deploy
```

デプロイ後に表示されるURL（例: `https://personal-line-agent.<your-subdomain>.workers.dev`）に
`/webhook` を付けたものを、LINE DevelopersのWebhook URLに設定し、「検証」ボタンで疎通確認してください。
以降の手順でこのURLを使うので控えておいてください。

### 4. 自分専用にするための userId を取得（Google連携を使うなら必須）

LINEの公式アカウントを友だち追加し、何かメッセージを送ると Cloudflareのログ（`npx wrangler tail`）で
`source.userId` が確認できます。それを設定すると自分以外からのメッセージには一切応答しなくなり、
毎日ダイジェストの送信先としても使われます。

```bash
npx wrangler secret put ALLOWED_USER_ID
```

### 5. Google Cloudプロジェクト・OAuthクライアントを作成（Google連携を使う場合）

1. [Google Cloud Console](https://console.cloud.google.com/) で新規プロジェクトを作成（既存でも可）
2. 「APIとサービス」→「ライブラリ」から **Google Calendar API** と **Google Tasks API** を有効化
3. 「APIとサービス」→「OAuth同意画面」で **User Type: 外部** を選び、テストユーザーに自分のGoogleアカウントを追加
   （個人利用なので「公開」に進む必要はありません）
4. 「認証情報」→「認証情報を作成」→「OAuthクライアントID」
   - アプリケーションの種類: **ウェブアプリケーション**
   - 承認済みのリダイレクトURI: `<3で控えたデプロイURL>/oauth/callback`
     （例: `https://personal-line-agent.<your-subdomain>.workers.dev/oauth/callback`）
5. 発行された **クライアントID** と **クライアントシークレット** を控える

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

### 6. Google連携を有効化

ブラウザで `<デプロイURL>/oauth/start` にアクセスし、Google側の同意画面で許可してください。
「Google連携が完了しました」と表示されれば成功です（`refresh_token` がD1に保存されます）。

### 7. 動作確認

LINEのトークで以下を試してください。

- `ヘルプ` … コマンド一覧が返る
- `追加 明日9:00 ゴミ出し` … リマインダー登録 + （Google連携済みなら）Google Tasksにも追加
- `今日` … 今日の予定とGoogle Tasksの未完了ToDoが返る
- 毎日 `DAILY_DIGEST_TIME_JST`（デフォルト08:00 JST）になると自動でダイジェストが届く

## ローカル開発

```bash
npm run dev
```

Cloudflare Tunnel等でローカルサーバーを公開し、一時的にWebhook URLを差し替えれば手元でも動作確認できます。

## 構成

```
src/
  index.ts               Honoアプリ本体。Webhook処理・OAuthルート・Cron Trigger
  line.ts                LINE Messaging APIの署名検証・reply・push
  google.ts              Google OAuth2 / Calendar / Tasks APIクライアント
  db.ts                  D1へのリマインダー・Googleトークン・アプリ状態のCRUD
  dateParser.ts          日本語の日時表現パーサー・JST変換ユーティリティ
migrations/
  0001_init.sql          remindersテーブルのスキーマ
  0002_google_integration.sql  google_tokens / app_stateテーブルのスキーマ
```
