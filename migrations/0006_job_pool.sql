-- 手動登録する求人票のプール。毎日ここからランダムに1件選んでThreadsへ投稿する。
-- circusからの自動取得の代わりに、LINEの「求人追加」コマンドで貯めていく。
CREATE TABLE IF NOT EXISTS job_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  content TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_pool_active ON job_pool (active);
