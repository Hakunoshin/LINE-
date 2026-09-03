// D1データベースへのリマインダーCRUDアクセス層。

export interface Reminder {
  id: number;
  user_id: string;
  content: string;
  due_at: string;
  notified: number;
  created_at: string;
}

export async function addReminder(
  db: D1Database,
  userId: string,
  content: string,
  dueAtUtcIso: string
): Promise<number> {
  const result = await db
    .prepare("INSERT INTO reminders (user_id, content, due_at) VALUES (?, ?, ?)")
    .bind(userId, content, dueAtUtcIso)
    .run();
  return result.meta.last_row_id as number;
}

export async function listPendingReminders(db: D1Database, userId: string): Promise<Reminder[]> {
  const result = await db
    .prepare(
      "SELECT * FROM reminders WHERE user_id = ? AND notified = 0 ORDER BY due_at ASC"
    )
    .bind(userId)
    .all<Reminder>();
  return result.results ?? [];
}

export async function deleteReminder(db: D1Database, userId: string, id: number): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM reminders WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function getDueReminders(db: D1Database, nowUtcIso: string): Promise<Reminder[]> {
  const result = await db
    .prepare("SELECT * FROM reminders WHERE notified = 0 AND due_at <= ?")
    .bind(nowUtcIso)
    .all<Reminder>();
  return result.results ?? [];
}

export async function markNotified(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE reminders SET notified = 1 WHERE id = ?").bind(id).run();
}

export interface GoogleTokens {
  refresh_token: string;
  access_token: string | null;
  access_token_expires_at: string | null;
}

export async function getGoogleTokens(db: D1Database): Promise<GoogleTokens | null> {
  const result = await db
    .prepare("SELECT refresh_token, access_token, access_token_expires_at FROM google_tokens WHERE id = 1")
    .first<GoogleTokens>();
  return result ?? null;
}

export async function saveGoogleRefreshToken(db: D1Database, refreshToken: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO google_tokens (id, refresh_token, updated_at)
       VALUES (1, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET refresh_token = excluded.refresh_token, updated_at = datetime('now')`
    )
    .bind(refreshToken)
    .run();
}

export async function saveGoogleAccessToken(
  db: D1Database,
  accessToken: string,
  expiresAtUtcIso: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE google_tokens SET access_token = ?, access_token_expires_at = ?, updated_at = datetime('now') WHERE id = 1"
    )
    .bind(accessToken, expiresAtUtcIso)
    .run();
}

export async function getAppState(db: D1Database, key: string): Promise<string | null> {
  const result = await db
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return result?.value ?? null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function getChatHistory(
  db: D1Database,
  userId: string,
  limit: number
): Promise<ChatMessage[]> {
  const result = await db
    .prepare(
      `SELECT role, content FROM (
         SELECT id, role, content FROM chat_history WHERE user_id = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`
    )
    .bind(userId, limit)
    .all<ChatMessage>();
  return result.results ?? [];
}

export async function appendChatHistory(
  db: D1Database,
  userId: string,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  await db
    .prepare("INSERT INTO chat_history (user_id, role, content) VALUES (?, ?, ?)")
    .bind(userId, role, content)
    .run();
  // 古い履歴は残しても使わないので、直近50件だけ保持する
  await db
    .prepare(
      `DELETE FROM chat_history WHERE user_id = ? AND id NOT IN (
         SELECT id FROM chat_history WHERE user_id = ? ORDER BY id DESC LIMIT 50
       )`
    )
    .bind(userId, userId)
    .run();
}

// ===== Threads(スレッズ)自動投稿 =====

export interface ThreadsTokenRow {
  access_token: string;
  expires_at: string | null;
}

export async function getThreadsToken(db: D1Database): Promise<ThreadsTokenRow | null> {
  const result = await db
    .prepare("SELECT access_token, expires_at FROM threads_tokens WHERE id = 1")
    .first<ThreadsTokenRow>();
  return result ?? null;
}

export async function saveThreadsToken(
  db: D1Database,
  accessToken: string,
  expiresAtUtcIso: string | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO threads_tokens (id, access_token, expires_at, updated_at)
       VALUES (1, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token,
         expires_at = excluded.expires_at, updated_at = datetime('now')`
    )
    .bind(accessToken, expiresAtUtcIso)
    .run();
}

export async function recordThreadsPost(
  db: D1Database,
  text: string,
  mediaId: string | null
): Promise<void> {
  await db
    .prepare("INSERT INTO threads_posts (text, media_id) VALUES (?, ?)")
    .bind(text, mediaId)
    .run();
}

export async function getRecentThreadsPosts(db: D1Database, limit: number): Promise<string[]> {
  const result = await db
    .prepare("SELECT text FROM threads_posts ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all<{ text: string }>();
  return (result.results ?? []).map((r) => r.text);
}

export async function setAppState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
    .bind(key, value)
    .run();
}
