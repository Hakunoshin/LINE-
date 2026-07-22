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

// --- Threads OAuthトークン(1行固定) ---

export interface ThreadsTokens {
  user_id: string;
  access_token: string;
  expires_at: string;
}

export async function getThreadsTokens(db: D1Database): Promise<ThreadsTokens | null> {
  const result = await db
    .prepare("SELECT user_id, access_token, expires_at FROM threads_tokens WHERE id = 1")
    .first<ThreadsTokens>();
  return result ?? null;
}

export async function saveThreadsTokens(
  db: D1Database,
  userId: string,
  accessToken: string,
  expiresAtUtcIso: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO threads_tokens (id, user_id, access_token, expires_at, updated_at)
       VALUES (1, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id,
         access_token = excluded.access_token,
         expires_at = excluded.expires_at,
         updated_at = datetime('now')`
    )
    .bind(userId, accessToken, expiresAtUtcIso)
    .run();
}

// --- 投稿指標(パフォーマンス分析用) ---

export interface PostMetric {
  media_id: string;
  job_key: string | null;
  text: string;
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  posted_at: string;
  metrics_updated_at: string | null;
  cta_type: string | null;
}

export async function insertPostMetric(
  db: D1Database,
  mediaId: string,
  jobKey: string,
  text: string,
  ctaType: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO threads_post_metrics (media_id, job_key, text, cta_type) VALUES (?, ?, ?, ?)
       ON CONFLICT(media_id) DO NOTHING`
    )
    .bind(mediaId, jobKey, text, ctaType)
    .run();
}

// CTA種別ごとの投稿数と平均エンゲージメント(いいね+返信+リポスト+引用)。A/B判定に使う。
export interface CtaStat {
  cta_type: string;
  n: number;
  avg_engagement: number;
}

export async function getCtaStats(db: D1Database): Promise<CtaStat[]> {
  const result = await db
    .prepare(
      `SELECT cta_type,
              COUNT(*) AS n,
              AVG(likes + replies + reposts + quotes) AS avg_engagement
       FROM threads_post_metrics
       WHERE metrics_updated_at IS NOT NULL AND cta_type IS NOT NULL
       GROUP BY cta_type`
    )
    .all<CtaStat>();
  return result.results ?? [];
}

export interface PostInsightValues {
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
}

export async function updatePostMetric(
  db: D1Database,
  mediaId: string,
  v: PostInsightValues
): Promise<void> {
  await db
    .prepare(
      `UPDATE threads_post_metrics
       SET views = ?, likes = ?, replies = ?, reposts = ?, quotes = ?, metrics_updated_at = datetime('now')
       WHERE media_id = ?`
    )
    .bind(v.views, v.likes, v.replies, v.reposts, v.quotes, mediaId)
    .run();
}

// 直近N日以内に投稿したもの(指標を更新したい対象)を返す。
export async function listRecentPostMetrics(db: D1Database, sinceUtcIso: string): Promise<PostMetric[]> {
  const result = await db
    .prepare("SELECT * FROM threads_post_metrics WHERE posted_at >= ? ORDER BY posted_at DESC")
    .bind(sinceUtcIso)
    .all<PostMetric>();
  return result.results ?? [];
}

// エンゲージメント(views優先)が高い順に上位を返す。分析のインプットに使う。
export async function listTopPostMetrics(db: D1Database, limit: number): Promise<PostMetric[]> {
  const result = await db
    .prepare(
      `SELECT * FROM threads_post_metrics
       WHERE metrics_updated_at IS NOT NULL
       ORDER BY (likes + replies + reposts + quotes) DESC, views DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<PostMetric>();
  return result.results ?? [];
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
