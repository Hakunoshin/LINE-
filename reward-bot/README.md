# reward-compare-line-bot（成約報酬くらべ bot）

企業名を送ると、人材紹介の**成約報酬が一番高い媒体**（circus / peterpan / trueaim）を
判定して返す LINE bot。個人用リマインダーbot（リポジトリ直下の personal-line-agent）とは
**別チャネル・別ワーカーの独立アプリ**です。

## 使い方

LINEでこう送るだけ:

```
株式会社レオパレス21 理論年収500万
```

返信例:

```
💰 成約報酬 比較: 株式会社レオパレス21
理論年収: 500万円 (手入力)

1. peterpan  150万円  (理論年収500万×30%)
   └ 30%
・circus: 該当求人なし
・trueaim: 該当求人なし

👑 一番高いのは peterpan (150万円)
```

- `ヘルプ` / `使い方` で説明を表示します。
- 企業名はできるだけフルネームで送ってください。

## 仕組み

- **peterpan / trueaim**: 公開Notion・公開Googleスプレッドシートから**認証不要で自動取得**
- **circus**: 主に理論年収の取得元。`CIRCUS_EMAIL` / `CIRCUS_PASSWORD` を設定すると
  自動ログイン取得を試みます（未設定なら理論年収は手入力）

報酬の書き方は2パターンに対応します。

1. **固定額型**: `100万`、`120万円`、`一律60万円（税別）` などはその金額を成約報酬とする
2. **料率型**: `35%`、`理論年収の35％`、`年収の35%` などは `理論年収 × 料率` で金額換算する

`新卒：90万円 中途：年収の35%` のような混在表記も、金額・料率を全部拾って一番高い額で比較します。
料率型を金額換算するには理論年収が必要なので、`理論年収500万` のように付けて送ってください。

> circusの内部APIはSPAから推定したもので公式仕様ではありません。ログイン方式
> （email/password → `x-circus-authentication-token`）は判明していますが、理論年収の
> レスポンス項目は実アカウントでの確認が必要です。取得に失敗した場合は理論年収の手入力に
> フォールバックし、peterpan / trueaim の比較は問題なく動作します。

## セットアップ

このディレクトリ (`reward-bot/`) 単体でデプロイします。

### 1. LINE Developersで**新しい**チャネルを作成

個人用botとは別のMessaging APIチャネルを作成し、Channel secret と
Channel access token (long-lived) を控えます。応答メッセージはオフに。

### 2. Secretを設定してデプロイ

```bash
cd reward-bot
npm install

npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET
# 任意: 自分専用にする / circus自動ログインを使う
npx wrangler secret put ALLOWED_USER_ID
npx wrangler secret put CIRCUS_EMAIL
npx wrangler secret put CIRCUS_PASSWORD

npm run deploy
```

デプロイ後のURL（例: `https://reward-compare-line-bot.<your-subdomain>.workers.dev`）に
`/webhook` を付けたものを、作成したチャネルの Webhook URL に設定してください。

## 構成

```
reward-bot/
  src/
    index.ts     Honoアプリ本体。LINE Webhook処理
    line.ts      LINE Messaging APIの署名検証・reply
    rewards.ts   成約報酬の取得(Notion/Sheet/circus)・報酬パース・比較
  package.json / wrangler.toml / tsconfig.json
```
