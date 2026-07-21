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

- **毎日ダイジェスト**: 毎日決まったJST時刻（デフォルト `07:30,13:00,18:00`、
  `DAILY_DIGEST_TIME_JST` にカンマ区切りで指定して変更可）に、Googleカレンダーの今日の予定 と
  Google Tasksの未完了ToDo をまとめてLINEへ自動プッシュ通知。ToDoが0件のときは「本日タスクなし」と表示
- **`今日` / `【タスク】` コマンド**: 上記と同じ内容をいつでも手動で取得
- **`追加` コマンドの自動反映**: LINEで追加したリマインダーをGoogle Tasksのデフォルトリストにも自動登録
  （Google Tasksは時刻指定ができないため、タイトルに `[HH:MM]` を付与して登録します）

カレンダーは読み取りのみ、ToDoはGoogle Tasksとの読み書きです（カレンダーへの書き込みは行いません）。

### circus求人のThreads自動投稿（任意）

[circus](https://circus-job.com/) の求人一覧を定期的に取得し、新着求人を [Threads](https://www.threads.net/) へ自動投稿します。

- 毎日決まったJST時刻（デフォルト `09:00,15:00,21:00` の1日3回、`THREADS_AUTOPOST_TIME_JST` にカンマ区切りで指定して変更可）に、circusの新着求人を1件ずつThreadsへ投稿
- 1回の実行で投稿する件数は `THREADS_MAX_POSTS_PER_RUN`（デフォルト `1`）で調整。過去に投稿した求人はD1に記録され、二度と投稿されません
- **投稿文はClaudeが生成**（`ANTHROPIC_API_KEY` 設定時）。後述の分析結果を踏まえて「伸びる型」に寄せて作文します。未設定時は定型テンプレートで投稿します
- **投稿するたびに、LINEの秘書から「この求人をThreadsに投稿しました🧵」と投稿本文つきで通知**が届きます
- LINEで `求人投稿` と送ると、その場で新着求人を取得して投稿できます（動作確認用）

#### パフォーマンス分析→改善ループ

投稿後、Threads Insights（閲覧数・いいね・返信・リポスト・引用）を毎日 `THREADS_INSIGHTS_TIME_JST`（デフォルト `23:30` JST）に取得してD1に蓄積します。
上位の投稿をClaudeが分析し、「どんな投稿が伸びるか」の改善メモを更新。次回以降の投稿生成にそのメモを渡すことで、投稿が継続的に改善されていきます。

#### 設定

circus（求人取得）:

```bash
# circusの求人一覧を返すエンドポイント
npx wrangler secret put CIRCUS_JOBS_URL
# circusへのログイン（メール+パスワード）。ログインで得たセッションで求人を取得します
npx wrangler secret put CIRCUS_LOGIN_URL
npx wrangler secret put CIRCUS_EMAIL
npx wrangler secret put CIRCUS_PASSWORD
# （ログインではなく静的なBearerトークンを直接持っている場合はこれだけでも可）
# npx wrangler secret put CIRCUS_API_TOKEN
```

Threads（投稿先）— OAuthアプリを登録するとトークンは自動で更新され、手動更新は不要になります:

```bash
npx wrangler secret put THREADS_APP_ID       # Threads App ID
npx wrangler secret put THREADS_APP_SECRET   # Threads App Secret
```

設定後、ブラウザで `<デプロイURL>/threads/start` にアクセスして投稿したいThreadsアカウントで認可すると、
長期トークン（約60日）がD1に保存され、期限が近づくとWorkerが自動でrefreshします。

##### Threadsアプリの作り方（初回のみ）

1. [Meta for Developers](https://developers.facebook.com/) でアプリを作成し、ユースケースに **Threads API** を追加
2. スコープに `threads_basic` / `threads_content_publish` / `threads_manage_insights` を追加
3. **Redirect Callback URLs** に `<デプロイURL>/threads/callback` を登録
4. 投稿したいThreadsアカウントを **Threads tester** として招待し、アカウント側で承認
5. **Threads App ID / App Secret** を上記の secret に登録し、`/threads/start` で連携

> 手動発行した長期トークンを直接使う場合は、代わりに `THREADS_USER_ID` と `THREADS_ACCESS_TOKEN` を secret に設定します（この場合、自動refreshは行われないため60日ごとに手動更新が必要です）。

circusへのログインは、デフォルトで `CIRCUS_LOGIN_URL` に `{ "email": ..., "password": ... }` をJSONでPOSTし、
レスポンスのSet-Cookie（セッション）またはJSON中のトークンを次のリクエストに引き継ぎます。
circus側のログインAPIの仕様（フィールド名・レスポンス形式）によっては `src/circus.ts` の `circusLogin` の調整が必要です。

circusのレスポンスは配列でも `{ "jobs": [...] }` / `{ "data": [...] }` / `{ "results": [...] }` のいずれでも受け付け、
`title`/`job_title`、`company`/`company_name` などフィールド名の揺れも吸収します。
投稿時刻や1回あたりの件数は `wrangler.toml` の `[vars]`（`THREADS_AUTOPOST_TIME_JST`, `THREADS_MAX_POSTS_PER_RUN`）でも指定できます。

### AI応答（任意）

`ANTHROPIC_API_KEY` を設定すると、コマンドに当てはまらないメッセージはすべてClaude（AI）が応答します。

- 「明日の朝9時にゴミ出しリマインドして」→ 自然な言葉のままリマインダー登録（Google Tasksにも反映）
- 「今日って何か予定あったっけ？」→ カレンダー/ToDoを確認して回答
- 「さっきのリマインダー消して」→ 会話の文脈を踏まえて削除
- 雑談や質問にも普通に応答

会話履歴（直近分）はD1に保存され、文脈を踏まえたやり取りができます。

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

APIキーは [Anthropic Console](https://platform.claude.com/) で発行できます（従量課金）。

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
  ai.ts                  Claude APIによる自由文応答エージェント(ツール付き)
  line.ts                LINE Messaging APIの署名検証・reply・push
  google.ts              Google OAuth2 / Calendar / Tasks APIクライアント
  circus.ts              circusログイン・求人取得・正規化・投稿文テンプレート
  threads.ts             Threads Graph API(投稿・OAuth・トークンrefresh・インサイト)
  threadsContent.ts      Claudeによる投稿文生成とパフォーマンス分析
  db.ts                  D1へのリマインダー・トークン・会話履歴・投稿済み求人・投稿指標のCRUD
  dateParser.ts          日本語の日時表現パーサー・JST変換ユーティリティ
migrations/
  0001_init.sql          remindersテーブルのスキーマ
  0002_google_integration.sql  google_tokens / app_stateテーブルのスキーマ
  0003_chat_history.sql  chat_historyテーブルのスキーマ
  0004_threads_posted_jobs.sql threads_posted_jobsテーブルのスキーマ
  0005_threads_oauth_and_metrics.sql  threads_tokens / threads_post_metricsテーブルのスキーマ
```
