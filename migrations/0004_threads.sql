-- Threads(スレッズ)自動投稿用。
-- 長期アクセストークンを保持し、自動更新した最新トークンをキャッシュする。
CREATE TABLE IF NOT EXISTS threads_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  expires_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 投稿済みの本文を記録する。重複投稿の回避(直近分をAIに渡す)と履歴確認に使う。
CREATE TABLE IF NOT EXISTS threads_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  media_id TEXT,
  posted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_threads_posts_posted_at ON threads_posts (posted_at);
