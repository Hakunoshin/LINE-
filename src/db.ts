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
