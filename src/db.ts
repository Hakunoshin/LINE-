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

export async function setAppState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
    .bind(key, value)
    .run();
}

// ---- Threads(Meta)連携 ----

export interface ThreadsTokens {
  access_token: string;
  token_expires_at: string | null;
  user_id: string;
  username: string | null;
}

export async function getThreadsTokens(db: D1Database): Promise<ThreadsTokens | null> {
  const result = await db
    .prepare("SELECT access_token, token_expires_at, user_id, username FROM threads_tokens WHERE id = 1")
    .first<ThreadsTokens>();
  return result ?? null;
}

/** 連携完了時に長期トークン一式を保存する(既存があれば上書き)。 */
export async function saveThreadsTokens(
  db: D1Database,
  tokens: { accessToken: string; expiresAtUtcIso: string | null; userId: string; username: string | null }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO threads_tokens (id, access_token, token_expires_at, user_id, username, updated_at)
       VALUES (1, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         access_token = excluded.access_token,
         token_expires_at = excluded.token_expires_at,
         user_id = excluded.user_id,
         username = excluded.username,
         updated_at = datetime('now')`
    )
    .bind(tokens.accessToken, tokens.expiresAtUtcIso, tokens.userId, tokens.username)
    .run();
}

/** 長期トークンのリフレッシュ時に、トークンと失効時刻だけを更新する。 */
export async function updateThreadsAccessToken(
  db: D1Database,
  accessToken: string,
  expiresAtUtcIso: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE threads_tokens SET access_token = ?, token_expires_at = ?, updated_at = datetime('now') WHERE id = 1"
    )
    .bind(accessToken, expiresAtUtcIso)
    .run();
}

export interface ThreadsPost {
  id: number;
  text: string;
  status: string;
  media_id: string | null;
  error: string | null;
  source: string;
  posted_at: string | null;
  created_at: string;
}

export async function addThreadsPost(
  db: D1Database,
  text: string,
  status: string,
  source: string
): Promise<number> {
  const result = await db
    .prepare("INSERT INTO threads_posts (text, status, source) VALUES (?, ?, ?)")
    .bind(text, status, source)
    .run();
  return result.meta.last_row_id as number;
}

export async function getThreadsPost(db: D1Database, id: number): Promise<ThreadsPost | null> {
  const result = await db
    .prepare("SELECT * FROM threads_posts WHERE id = ?")
    .bind(id)
    .first<ThreadsPost>();
  return result ?? null;
}

/** 投稿成功: statusをpostedにし、media_idとposted_atを記録する。 */
export async function markThreadsPosted(db: D1Database, id: number, mediaId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE threads_posts SET status = 'posted', media_id = ?, error = NULL, posted_at = datetime('now') WHERE id = ?"
    )
    .bind(mediaId, id)
    .run();
}

/** 投稿失敗: statusをfailedにし、理由を記録する。 */
export async function markThreadsFailed(db: D1Database, id: number, error: string): Promise<void> {
  await db
    .prepare("UPDATE threads_posts SET status = 'failed', error = ? WHERE id = ?")
    .bind(error.slice(0, 500), id)
    .run();
}

export async function setThreadsPostStatus(db: D1Database, id: number, status: string): Promise<void> {
  await db.prepare("UPDATE threads_posts SET status = ? WHERE id = ?").bind(status, id).run();
}

/** 直近の投稿を新しい順に取得する。言い換え用の文脈・状態表示に使う。 */
export async function listRecentThreadsPosts(db: D1Database, limit: number): Promise<ThreadsPost[]> {
  const result = await db
    .prepare("SELECT * FROM threads_posts ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all<ThreadsPost>();
  return result.results ?? [];
}
