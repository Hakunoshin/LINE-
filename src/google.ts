// Google OAuth2 (Calendar読み取り + Tasks読み書き) 用ヘルパー。
// Workerが自分でOAuthのstart/callbackを担当し、refresh tokenはD1に保存する。

import { getGoogleTokens, saveGoogleAccessToken, saveGoogleRefreshToken } from "./db";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/tasks",
].join(" ");

export function buildGoogleAuthUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  token_type: string;
}

export async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string,
  db: D1Database
): Promise<void> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  }
  const tokens = (await res.json()) as GoogleTokenResponse;
  if (!tokens.refresh_token) {
    throw new Error(
      "refresh_tokenが返却されませんでした。既に連携済みの場合はGoogleアカウントの「サードパーティのアクセス権」からこのアプリを一度解除してからやり直してください。"
    );
  }
  await saveGoogleRefreshToken(db, tokens.refresh_token);
  await saveGoogleAccessToken(
    db,
    tokens.access_token,
    new Date(Date.now() + tokens.expires_in * 1000).toISOString()
  );
}

/** 有効なアクセストークンを返す。期限切れ/未取得ならrefresh_tokenで更新する。 */
export async function getValidAccessToken(
  clientId: string,
  clientSecret: string,
  db: D1Database
): Promise<string | null> {
  const tokens = await getGoogleTokens(db);
  if (!tokens) return null;

  const isExpired =
    !tokens.access_token ||
    !tokens.access_token_expires_at ||
    new Date(tokens.access_token_expires_at).getTime() <= Date.now() + 60_000;

  if (!isExpired && tokens.access_token) {
    return tokens.access_token;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
  }
  const refreshed = (await res.json()) as GoogleTokenResponse;
  await saveGoogleAccessToken(
    db,
    refreshed.access_token,
    new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
  );
  return refreshed.access_token;
}

export interface CalendarEvent {
  summary: string;
  startIso: string;
  isAllDay: boolean;
}

export async function listTodayEvents(
  accessToken: string,
  startUtcIso: string,
  endUtcIso: string
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin: startUtcIso,
    timeMax: endUtcIso,
    singleEvents: "true",
    orderBy: "startTime",
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    throw new Error(`Calendar API error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    items?: Array<{ summary?: string; start?: { dateTime?: string; date?: string } }>;
  };
  return (data.items ?? []).map((item) => {
    const isAllDay = !item.start?.dateTime;
    return {
      summary: item.summary ?? "(タイトルなし)",
      startIso: item.start?.dateTime ?? item.start?.date ?? "",
      isAllDay,
    };
  });
}

export interface GoogleTask {
  id: string;
  title: string;
}

export async function listIncompleteTasks(accessToken: string): Promise<GoogleTask[]> {
  const params = new URLSearchParams({
    showCompleted: "false",
    showDeleted: "false",
    showHidden: "false",
  });
  const res = await fetch(
    `https://www.googleapis.com/tasks/v1/lists/@default/tasks?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    throw new Error(`Tasks API error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { items?: Array<{ id: string; title?: string }> };
  return (data.items ?? []).map((item) => ({ id: item.id, title: item.title ?? "(無題)" }));
}

export async function insertTask(
  accessToken: string,
  title: string,
  dueDateOnlyUtcIso?: string
): Promise<void> {
  const res = await fetch("https://www.googleapis.com/tasks/v1/lists/@default/tasks", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title,
      due: dueDateOnlyUtcIso,
    }),
  });
  if (!res.ok) {
    throw new Error(`Tasks API insert error: ${res.status} ${await res.text()}`);
  }
}
