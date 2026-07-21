-- circusから拾ってThreadsに自動投稿した求人の記録。
-- job_key(circus側のID等)で一意にし、同じ求人を二度投稿しないようにする。
CREATE TABLE IF NOT EXISTS threads_posted_jobs (
  job_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  media_id TEXT,
  posted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
