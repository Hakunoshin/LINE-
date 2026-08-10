-- Threads(Meta)連携のOAuthトークン。
-- 投稿先は「別アカウント」1つ分を想定し1行固定(id=1)。
CREATE TABLE IF NOT EXISTS threads_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  threads_user_id TEXT NOT NULL,      -- 投稿先のThreadsユーザーID
  username TEXT,                      -- 表示用ユーザー名(@なし)
  access_token TEXT NOT NULL,         -- 長期アクセストークン
  expires_at TEXT NOT NULL,           -- 長期トークンの失効時刻(UTC ISO)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Threadsの予約投稿キュー。scheduled_atになるとCronが自動公開する。
CREATE TABLE IF NOT EXISTS thread_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,              -- 予約したLINEユーザー
  text TEXT NOT NULL,                 -- 投稿本文
  scheduled_at TEXT NOT NULL,         -- 公開予定(UTC ISO)
  status TEXT NOT NULL DEFAULT 'pending', -- pending / posted / failed
  posted_at TEXT,                     -- 公開に成功した時刻(UTC ISO)
  permalink TEXT,                     -- 公開後のパーマリンク(取得できた場合)
  error TEXT,                         -- 失敗時のエラーメッセージ
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_thread_posts_due ON thread_posts (scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_thread_posts_user ON thread_posts (user_id);
