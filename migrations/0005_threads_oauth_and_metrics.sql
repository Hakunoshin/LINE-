-- Threadsの長期アクセストークンを1行で保持し、Workerが自動でrefreshする(Google同様)。
CREATE TABLE IF NOT EXISTS threads_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 投稿ごとの本文とエンゲージメント指標。定期的にThreads Insightsで更新し、
-- 「どんな投稿が伸びるか」の分析に使う。
CREATE TABLE IF NOT EXISTS threads_post_metrics (
  media_id TEXT PRIMARY KEY,
  job_key TEXT,
  text TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  reposts INTEGER NOT NULL DEFAULT 0,
  quotes INTEGER NOT NULL DEFAULT 0,
  posted_at TEXT NOT NULL DEFAULT (datetime('now')),
  metrics_updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_threads_metrics_posted_at ON threads_post_metrics (posted_at);
