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

// ===== X(旧Twitter)自動運用チーム =====

export type XSeedKind = "account" | "keyword" | "reference";

export interface XSeed {
  id: number;
  user_id: string;
  kind: XSeedKind;
  value: string;
  created_at: string;
}

export async function addXSeed(
  db: D1Database,
  userId: string,
  kind: XSeedKind,
  value: string
): Promise<number> {
  const result = await db
    .prepare("INSERT INTO x_seeds (user_id, kind, value) VALUES (?, ?, ?)")
    .bind(userId, kind, value)
    .run();
  return result.meta.last_row_id as number;
}

export async function listXSeeds(db: D1Database, userId: string): Promise<XSeed[]> {
  const result = await db
    .prepare("SELECT * FROM x_seeds WHERE user_id = ? ORDER BY kind ASC, id ASC")
    .bind(userId)
    .all<XSeed>();
  return result.results ?? [];
}

export async function deleteXSeed(db: D1Database, userId: string, id: number): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM x_seeds WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export type XDraftStatus = "pending" | "approved" | "posted" | "rejected";

export interface XDraft {
  id: number;
  user_id: string;
  content: string;
  rationale: string | null;
  status: XDraftStatus;
  scheduled_at: string | null;
  posted_at: string | null;
  source_note: string | null;
  created_at: string;
}

export async function addXDraft(
  db: D1Database,
  userId: string,
  content: string,
  rationale: string | null,
  sourceNote: string | null
): Promise<number> {
  const result = await db
    .prepare(
      "INSERT INTO x_drafts (user_id, content, rationale, status, source_note) VALUES (?, ?, ?, 'pending', ?)"
    )
    .bind(userId, content, rationale, sourceNote)
    .run();
  return result.meta.last_row_id as number;
}

export async function getXDraft(db: D1Database, userId: string, id: number): Promise<XDraft | null> {
  const result = await db
    .prepare("SELECT * FROM x_drafts WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<XDraft>();
  return result ?? null;
}

export async function listXDraftsByStatus(
  db: D1Database,
  userId: string,
  statuses: XDraftStatus[]
): Promise<XDraft[]> {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT * FROM x_drafts WHERE user_id = ? AND status IN (${placeholders}) ORDER BY id ASC`
    )
    .bind(userId, ...statuses)
    .all<XDraft>();
  return result.results ?? [];
}

/** 承認して投稿予定時刻をセットする(status=approved)。 */
export async function approveXDraft(
  db: D1Database,
  userId: string,
  id: number,
  scheduledAtUtcIso: string
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE x_drafts SET status = 'approved', scheduled_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'"
    )
    .bind(scheduledAtUtcIso, id, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function rejectXDraft(db: D1Database, userId: string, id: number): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE x_drafts SET status = 'rejected' WHERE id = ? AND user_id = ? AND status = 'pending'"
    )
    .bind(id, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** 投稿予定時刻を過ぎた承認済みドラフトを取得する(自動投稿cron用)。 */
export async function getDueApprovedXDrafts(db: D1Database, nowUtcIso: string): Promise<XDraft[]> {
  const result = await db
    .prepare(
      "SELECT * FROM x_drafts WHERE status = 'approved' AND scheduled_at IS NOT NULL AND scheduled_at <= ? ORDER BY scheduled_at ASC"
    )
    .bind(nowUtcIso)
    .all<XDraft>();
  return result.results ?? [];
}

export async function markXDraftPosted(db: D1Database, id: number, postedAtUtcIso: string): Promise<void> {
  await db
    .prepare("UPDATE x_drafts SET status = 'posted', posted_at = ? WHERE id = ?")
    .bind(postedAtUtcIso, id)
    .run();
}
