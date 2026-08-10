// Threads(Meta) 連携ヘルパー。
// Google連携と同様に、Workerが自分でOAuthのstart/callbackを担当し、
// 「別アカウント」の長期アクセストークンをD1に保存して自動更新する。
// 参考: https://developers.facebook.com/docs/threads

import {
  getThreadsToken,
  saveThreadsToken,
  updateThreadsAccessToken,
  type ThreadsToken,
} from "./db";

const GRAPH_BASE = "https://graph.threads.net";
const GRAPH_VERSION = "v1.0";

// 投稿に必要な最小スコープ(プロフィール参照 + 投稿公開)
const SCOPES = ["threads_basic", "threads_content_publish"].join(",");

// Threadsのテキスト投稿の上限は500文字
export const THREADS_TEXT_LIMIT = 500;

export function buildThreadsAuthUrl(appId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    response_type: "code",
  });
  return `https://threads.net/oauth/authorize?${params.toString()}`;
}

interface ShortLivedTokenResponse {
  access_token: string;
  user_id: string | number;
}

interface LongLivedTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // 秒(通常60日)
}

/**
 * OAuthのcodeを短期トークンに交換し、さらに長期トークン(約60日)へ交換して、
 * 投稿先ユーザーの情報とともにD1へ保存する。
 */
export async function exchangeThreadsCode(
  appId: string,
  appSecret: string,
  redirectUri: string,
  code: string,
  db: D1Database
): Promise<{ username: string | null }> {
  // 1. code -> 短期トークン
  const shortRes = await fetch(`${GRAPH_BASE}/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    }),
  });
  if (!shortRes.ok) {
    throw new Error(`Threads short-lived token exchange failed: ${shortRes.status} ${await shortRes.text()}`);
  }
  const short = (await shortRes.json()) as ShortLivedTokenResponse;

  // 2. 短期 -> 長期トークン(約60日)
  const longParams = new URLSearchParams({
    grant_type: "th_exchange_token",
    client_secret: appSecret,
    access_token: short.access_token,
  });
  const longRes = await fetch(`${GRAPH_BASE}/access_token?${longParams.toString()}`);
  if (!longRes.ok) {
    throw new Error(`Threads long-lived token exchange failed: ${longRes.status} ${await longRes.text()}`);
  }
  const long = (await longRes.json()) as LongLivedTokenResponse;

  // 3. 投稿先ユーザーの情報を取得(表示用のusername)
  let username: string | null = null;
  try {
    const me = await getMe(long.access_token);
    username = me.username;
  } catch {
    // usernameは表示用途のみ。取得できなくても保存は続行する。
  }

  await saveThreadsToken(db, {
    threadsUserId: String(short.user_id),
    username,
    accessToken: long.access_token,
    expiresAtUtcIso: new Date(Date.now() + long.expires_in * 1000).toISOString(),
  });

  return { username };
}

/**
 * 有効な長期アクセストークンを返す。失効が近ければ(24時間以内)自動でリフレッシュする。
 * 未連携ならnull。
 */
export async function getValidThreadsToken(db: D1Database): Promise<ThreadsToken | null> {
  const token = await getThreadsToken(db);
  if (!token) return null;

  const expiresAt = new Date(token.expires_at).getTime();
  const nearExpiry = expiresAt <= Date.now() + 24 * 60 * 60 * 1000;
  if (!nearExpiry) return token;

  // 長期トークンのリフレッシュ(発行から24時間以上経過し、かつ失効前のみ可能)
  const params = new URLSearchParams({
    grant_type: "th_refresh_token",
    access_token: token.access_token,
  });
  const res = await fetch(`${GRAPH_BASE}/refresh_access_token?${params.toString()}`);
  if (!res.ok) {
    // 失効済み等でリフレッシュできない場合は、期限内なら既存トークンで投稿を試みる。
    if (expiresAt > Date.now()) return token;
    throw new Error(`Threads token refresh failed: ${res.status} ${await res.text()}`);
  }
  const refreshed = (await res.json()) as LongLivedTokenResponse;
  const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  await updateThreadsAccessToken(db, refreshed.access_token, newExpiry);
  return { ...token, access_token: refreshed.access_token, expires_at: newExpiry };
}

export async function getMe(accessToken: string): Promise<{ id: string; username: string | null }> {
  const params = new URLSearchParams({ fields: "id,username", access_token: accessToken });
  const res = await fetch(`${GRAPH_BASE}/${GRAPH_VERSION}/me?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Threads /me error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { id: string; username?: string };
  return { id: data.id, username: data.username ?? null };
}

/**
 * テキスト投稿を公開する(2ステップ: コンテナ作成 -> 公開)。
 * 公開後のメディアIDと、取得できればパーマリンクを返す。
 */
export async function publishTextPost(
  token: ThreadsToken,
  text: string
): Promise<{ mediaId: string; permalink: string | null }> {
  const userId = token.threads_user_id;
  const accessToken = token.access_token;

  // 1. メディアコンテナを作成
  const createRes = await fetch(`${GRAPH_BASE}/${GRAPH_VERSION}/${encodeURIComponent(userId)}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      media_type: "TEXT",
      text,
      access_token: accessToken,
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Threads container create error: ${createRes.status} ${await createRes.text()}`);
  }
  const created = (await createRes.json()) as { id: string };

  // 2. コンテナを公開
  const publishRes = await fetch(
    `${GRAPH_BASE}/${GRAPH_VERSION}/${encodeURIComponent(userId)}/threads_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        creation_id: created.id,
        access_token: accessToken,
      }),
    }
  );
  if (!publishRes.ok) {
    throw new Error(`Threads publish error: ${publishRes.status} ${await publishRes.text()}`);
  }
  const published = (await publishRes.json()) as { id: string };

  // 3. パーマリンクを取得(失敗しても投稿自体は成功しているので無視)
  let permalink: string | null = null;
  try {
    const linkParams = new URLSearchParams({ fields: "permalink", access_token: accessToken });
    const linkRes = await fetch(
      `${GRAPH_BASE}/${GRAPH_VERSION}/${encodeURIComponent(published.id)}?${linkParams.toString()}`
    );
    if (linkRes.ok) {
      const linkData = (await linkRes.json()) as { permalink?: string };
      permalink = linkData.permalink ?? null;
    }
  } catch {
    // noop
  }

  return { mediaId: published.id, permalink };
}
