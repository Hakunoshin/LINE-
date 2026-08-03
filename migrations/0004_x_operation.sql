-- X(旧Twitter)自動運用チーム用のスキーマ。
-- ネタ元(リサーチ対象)と、生成された投稿ドラフト/投稿キューを保持する。

-- リサーチのネタ元。kind: 'account'(@付き参考アカウント) | 'keyword'(検索/テーマ語) | 'reference'(貼り付けたバズ投稿本文)
CREATE TABLE IF NOT EXISTS x_seeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('account', 'keyword', 'reference')),
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_x_seeds_user ON x_seeds (user_id, kind);

-- 投稿ドラフト兼キュー。
-- status: 'pending'(承認待ち) | 'approved'(承認済・投稿待ち) | 'posted'(投稿済) | 'rejected'(却下)
CREATE TABLE IF NOT EXISTS x_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,          -- 投稿本文
  rationale TEXT,                 -- なぜ伸びるか/どの型か(承認判断の材料)
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_at TEXT,             -- 承認時に決まる投稿予定時刻(UTC ISO)。NULLなら即時扱い
  posted_at TEXT,               -- 実際に投稿した時刻(UTC ISO)
  source_note TEXT,             -- 何を元に作ったか(ネタ元/参考投稿など)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_x_drafts_user_status ON x_drafts (user_id, status, id);
