# personal-line-agent

自分専用のLINEリマインダー/タスク管理エージェント。Cloudflare Workers + D1 + LINE Messaging APIで動きます。

## できること

LINEでトークを送るだけでリマインダーを登録・確認・削除できます。指定した日時になると Cron Trigger が1分ごとにチェックし、LINEへプッシュ通知します。

```
追加 明日9:00 ゴミ出し
一覧
削除 3
ヘルプ
```

日時の指定は以下のような形式に対応しています。

- `今日` / `明日` / `明後日` + `HH:MM` または `H時M分`
- `YYYY-MM-DD HH:MM`
- `M/D HH:MM`（年省略時は現在の年、過ぎていれば翌年扱い）
- 時刻を省略した場合は 9:00 扱いになります

## セットアップ

### 1. LINE Developersでチャネルを作成

1. [LINE Developers Console](https://developers.line.biz/console/) にログイン
2. 新規プロバイダー作成 → **Messaging API** チャネルを作成
3. チャネル基本設定から **Channel secret** を控える
4. Messaging API設定タブから **Channel access token (long-lived)** を発行して控える
5. Webhookの利用を **オン** にする（URLは後述のデプロイ後に設定）
6. 応答メッセージ（自動応答/あいさつメッセージ）は **オフ** にしておく

### 2. 自分専用にするための userId を取得（推奨）

Webhookを一旦誰でも使える状態でデプロイした後、自分のLINEアカウントから何かメッセージを送ると
Cloudflareのログ（`wrangler tail`）で `source.userId` が確認できます。それを `ALLOWED_USER_ID` に設定すると、
自分以外からのメッセージには一切応答しなくなります。

### 3. D1データベースを作成

```bash
npx wrangler d1 create personal-line-agent-db
```

出力された `database_id` を `wrangler.toml` の `REPLACE_WITH_YOUR_D1_DATABASE_ID` に反映してください。

```bash
npm run db:migrate:local   # ローカル動作確認用
npm run db:migrate:remote  # 本番反映
```

### 4. Secretsを設定

```bash
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put ALLOWED_USER_ID   # 任意（自分のuserIdを設定して本人限定にする）
```

### 5. デプロイ

```bash
npm install
npm run deploy
```

デプロイ後に表示されるURL（例: `https://personal-line-agent.<your-subdomain>.workers.dev`）に
`/webhook` を付けたものを、LINE DevelopersのWebhook URLに設定し、「検証」ボタンで疎通確認してください。

### 6. 動作確認

LINEの公式アカウント（作成したチャネル）を友だち追加し、トークで `ヘルプ` と送信して応答があればOKです。

## ローカル開発

```bash
npm run dev
```

Cloudflare Tunnel等でローカルサーバーを公開し、一時的にWebhook URLを差し替えれば手元でも動作確認できます。

## 構成

```
src/
  index.ts       Honoアプリ本体。Webhook処理 + Cron Triggerでのリマインダー送信
  line.ts        LINE Messaging APIの署名検証・reply・push
  db.ts          D1へのリマインダーCRUD
  dateParser.ts  日本語の日時表現パーサー
migrations/
  0001_init.sql  remindersテーブルのスキーマ
```
