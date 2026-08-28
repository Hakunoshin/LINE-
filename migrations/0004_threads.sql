-- Threads (Meta) 連携用。長期アクセストークン(1アカウント分のみを想定し1行固定)
CREATE TABLE IF NOT EXISTS threads_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  token_expires_at TEXT,        -- 長期トークンの失効時刻(UTC ISO)
  user_id TEXT NOT NULL,        -- Threads(Instagram)ユーザーID。投稿先の指定に使う
  username TEXT,                -- 表示用のユーザー名(取得できた場合)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- AI自動投稿・下書き・投稿履歴。重複回避(直近との言い換え)と状態表示に使う
CREATE TABLE IF NOT EXISTS threads_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  -- draft: 承認待ちの下書き / posting: 投稿処理中 / posted: 投稿済み
  -- failed: 投稿失敗 / skipped: 却下
  status TEXT NOT NULL DEFAULT 'draft',
  media_id TEXT,                -- Threads側の投稿ID(投稿成功時)
  error TEXT,                   -- 失敗理由(失敗時)
  source TEXT NOT NULL DEFAULT 'auto',  -- auto: 自動投稿 / manual: 手動 / draft: 下書き承認
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_threads_posts_created ON threads_posts (created_at DESC);
