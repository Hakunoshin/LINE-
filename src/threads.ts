// Threads (Meta) Graph API へのテキスト投稿ヘルパー。
// 投稿は2段階: (1) メディアコンテナを作成 → creation_id を得る
//              (2) その creation_id を publish して実際に投稿する。
// 必要な認証情報:
//   THREADS_USER_ID      … Threads の User ID (数値文字列)
//   THREADS_ACCESS_TOKEN … 長期アクセストークン (threads_basic, threads_content_publish 権限)

import { getThreadsTokens, saveThreadsTokens, type ThreadsTokens } from "./db";

const THREADS_API_BASE = "https://graph.threads.net/v1.0";
// OAuth/トークン交換系はバージョン無しのホストを使う。
const THREADS_OAUTH_BASE = "https://graph.threads.net";

// 投稿・インサイト・トークン管理に必要なスコープ。
const THREADS_SCOPES = ["threads_basic", "threads_content_publish", "threads_manage_insights"].join(",");

// Threadsのテキスト投稿は500文字まで。
export const THREADS_TEXT_LIMIT = 500;

export interface ThreadsConfig {
  userId: string;
  accessToken: string;
}

/** 500文字を超えるテキストは末尾を「…」で丸める。 */
export function truncateForThreads(text: string): string {
  if (text.length <= THREADS_TEXT_LIMIT) return text;
  return text.slice(0, THREADS_TEXT_LIMIT - 1) + "…";
}

async function postForm(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`${THREADS_API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Threads API error (${path}): ${res.status} ${text}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Threads API returned non-JSON (${path}): ${text}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// コンテナの状態が FINISHED(公開可能) になるまでポーリングする。
// ERROR/EXPIRED は例外。上限まで待っても FINISHED にならなければそのまま進む(公開は成功しうる)。
async function waitForContainerReady(config: ThreadsConfig, creationId: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const params = new URLSearchParams({
      fields: "status,error_message",
      access_token: config.accessToken,
    });
    const res = await fetch(`${THREADS_API_BASE}/${creationId}?${params.toString()}`);
    const text = await res.text();
    if (res.ok) {
      const data = JSON.parse(text) as { status?: string; error_message?: string };
      if (data.status === "FINISHED" || data.status === "PUBLISHED") return;
      if (data.status === "ERROR" || data.status === "EXPIRED") {
        throw new Error(`Threads container ${data.status}: ${data.error_message ?? ""}`);
      }
    }
    await sleep(1500);
  }
}

/**
 * テキストのみのThreads投稿を作成して公開する。公開されたメディアIDを返す。
 * テキストは自動で500文字に丸める。
 */
export async function postThreadsText(config: ThreadsConfig, text: string): Promise<string> {
  const body = truncateForThreads(text);

  // (1) コンテナ作成
  const created = await postForm(`/${config.userId}/threads`, {
    media_type: "TEXT",
    text: body,
    access_token: config.accessToken,
  });
  const creationId = created.id;
  if (typeof creationId !== "string") {
    throw new Error(`Threads container creation returned no id: ${JSON.stringify(created)}`);
  }

  // (2) コンテナが公開可能(FINISHED)になるまで待つ。
  // 作成直後に公開すると準備が間に合わず400になることがあるため(競合対策)。
  await waitForContainerReady(config, creationId);

  // (3) 公開
  const published = await postForm(`/${config.userId}/threads_publish`, {
    creation_id: creationId,
    access_token: config.accessToken,
  });
  const mediaId = published.id;
  if (typeof mediaId !== "string") {
    throw new Error(`Threads publish returned no id: ${JSON.stringify(published)}`);
  }
  return mediaId;
}

// =====================================================================
// OAuth(認可コード → 短命 → 長期トークン)とrefresh、インサイト取得。
// これによりトークンの手動更新が不要になる(60日ごとの自動refresh)。
// =====================================================================

/** ブラウザに開かせる認可URLを組み立てる。 */
export function buildThreadsAuthUrl(appId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: THREADS_SCOPES,
    response_type: "code",
  });
  return `https://threads.net/oauth/authorize?${params.toString()}`;
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`Threads OAuth error: ${res.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * 認可コードを受け取り、長期トークン(約60日)まで交換してD1に保存する。
 * (1)code→短命+user_id (2)短命→長期。
 */
export async function completeThreadsOAuth(
  appId: string,
  appSecret: string,
  redirectUri: string,
  code: string,
  db: D1Database
): Promise<void> {
  // (1) code → 短命トークン + user_id
  const shortRes = await fetch(`${THREADS_OAUTH_BASE}/oauth/access_token`, {
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
  const shortText = await shortRes.text();
  if (!shortRes.ok) throw new Error(`Threads code exchange failed: ${shortRes.status} ${shortText}`);
  const shortData = JSON.parse(shortText) as { access_token?: string; user_id?: string | number };
  if (!shortData.access_token || shortData.user_id == null) {
    throw new Error(`Threads code exchange returned no token/user_id: ${shortText}`);
  }
  const userId = String(shortData.user_id);

  // (2) 短命 → 長期トークン
  const longParams = new URLSearchParams({
    grant_type: "th_exchange_token",
    client_secret: appSecret,
    access_token: shortData.access_token,
  });
  const longData = (await getJson(`${THREADS_OAUTH_BASE}/access_token?${longParams.toString()}`)) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!longData.access_token) {
    throw new Error(`Threads long-lived exchange returned no token: ${JSON.stringify(longData)}`);
  }
  const expiresInSec = typeof longData.expires_in === "number" ? longData.expires_in : 5_184_000;
  await saveThreadsTokens(
    db,
    userId,
    longData.access_token,
    new Date(Date.now() + expiresInSec * 1000).toISOString()
  );
}

/** D1に保存済みの長期トークンをrefreshして保存し直す(24時間以上経過したトークンのみ有効)。 */
async function refreshThreadsToken(db: D1Database, tokens: ThreadsTokens): Promise<string> {
  const params = new URLSearchParams({
    grant_type: "th_refresh_token",
    access_token: tokens.access_token,
  });
  const data = (await getJson(`${THREADS_OAUTH_BASE}/refresh_access_token?${params.toString()}`)) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error(`Threads token refresh returned no token: ${JSON.stringify(data)}`);
  }
  const expiresInSec = typeof data.expires_in === "number" ? data.expires_in : 5_184_000;
  await saveThreadsTokens(
    db,
    tokens.user_id,
    data.access_token,
    new Date(Date.now() + expiresInSec * 1000).toISOString()
  );
  return data.access_token;
}

/**
 * D1のトークンを使って有効な認証情報を返す。期限が近ければ(既定10日)自動でrefreshする。
 * トークン未保存(未連携)なら null。
 */
export async function getValidThreadsConfig(db: D1Database): Promise<ThreadsConfig | null> {
  const tokens = await getThreadsTokens(db);
  if (!tokens) return null;

  const expiringSoon =
    new Date(tokens.expires_at).getTime() <= Date.now() + 10 * 24 * 60 * 60 * 1000;

  let accessToken = tokens.access_token;
  if (expiringSoon) {
    try {
      accessToken = await refreshThreadsToken(db, tokens);
    } catch {
      // refreshに失敗しても、まだ期限内なら既存トークンで投稿を試みる
    }
  }
  return { userId: tokens.user_id, accessToken };
}

export interface ThreadsInsights {
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
}

/** 1投稿のインサイト(閲覧数・いいね等)を取得する。取得できない指標は0にする。 */
export async function getThreadsInsights(config: ThreadsConfig, mediaId: string): Promise<ThreadsInsights> {
  const params = new URLSearchParams({
    metric: "views,likes,replies,reposts,quotes",
    access_token: config.accessToken,
  });
  const res = await fetch(`${THREADS_API_BASE}/${mediaId}/insights?${params.toString()}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`Threads insights error (${mediaId}): ${res.status} ${text}`);

  const data = JSON.parse(text) as {
    data?: Array<{ name?: string; values?: Array<{ value?: number }>; total_value?: { value?: number } }>;
  };
  const result: ThreadsInsights = { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0 };
  for (const item of data.data ?? []) {
    const value = item.total_value?.value ?? item.values?.[0]?.value ?? 0;
    if (item.name && item.name in result) {
      result[item.name as keyof ThreadsInsights] = value;
    }
  }
  return result;
}
