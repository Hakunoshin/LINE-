CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  due_at TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reminders_due_at ON reminders (due_at) WHERE notified = 0;
CREATE INDEX IF NOT EXISTS idx_reminders_user_id ON reminders (user_id);
