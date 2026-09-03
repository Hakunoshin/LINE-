// Threads (Meta) の投稿APIとの連携。
// 投稿は「メディアコンテナ作成 → 公開」の2ステップ。長期アクセストークン(60日)を
// D1にキャッシュし、期限が近づいたら自動更新する。
//
// 参考: https://developers.facebook.com/docs/threads

import {
  getThreadsToken,
  saveThreadsToken,
  getAppState,
  setAppState,
} from "./db";

const GRAPH_BASE = "https://graph.threads.net/v1.0";
const REFRESH_URL = "https://graph.threads.net/refresh_access_token";

// Threads本文の上限は500文字。少し余裕を持たせて切り詰める。
export const THREADS_TEXT_LIMIT = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphPost(url: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    throw new Error(`Threads API error (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

async function graphGet(url: string): Promise<any> {
  const res = await fetch(url);
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    throw new Error(`Threads API error (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

/**
 * 有効な長期アクセストークンを返す。D1に無ければsecret(seedToken)で初期化し、
 * 期限が5日以内(または不明)なら自動更新して保存する。取得できなければnull。
 */
export async function getValidThreadsToken(
  db: D1Database,
  seedToken: string | undefined
): Promise<string | null> {
  const row = await getThreadsToken(db);
  let token = row?.access_token ?? seedToken ?? null;
  if (!token) return null;

  // secretのトークンをまだD1に保存していなければ初期投入(期限は不明のまま)
  if (!row && seedToken) {
    await saveThreadsToken(db, seedToken, null);
  }

  const now = Date.now();
  const expiresAt = row?.expires_at ? new Date(row.expires_at).getTime() : 0;
  const needsRefresh = !expiresAt || expiresAt - now < 5 * 24 * 60 * 60 * 1000;

  if (needsRefresh) {
    try {
      // 長期トークンの更新。発行から24時間未満のトークンは更新できずエラーになるが、
      // その場合は現行トークンをそのまま使う(catchで握りつぶす)。
      const url = `${REFRESH_URL}?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`;
      const json = await graphGet(url);
      if (json.access_token) {
        token = json.access_token as string;
        const expiresInSec = Number(json.expires_in ?? 0);
        const newExpiry = expiresInSec
          ? new Date(now + expiresInSec * 1000).toISOString()
          : null;
        await saveThreadsToken(db, token, newExpiry);
      }
    } catch {
      // 更新失敗時は現行トークンを使い続ける
    }
  }

  return token;
}

/** ThreadsユーザーIDを解決する。app_stateにキャッシュする。 */
export async function resolveThreadsUserId(db: D1Database, token: string): Promise<string> {
  const cached = await getAppState(db, "threads_user_id");
  if (cached) return cached;
  const url = `${GRAPH_BASE}/me?fields=id,username&access_token=${encodeURIComponent(token)}`;
  const json = await graphGet(url);
  const id = String(json.id ?? "");
  if (!id) throw new Error("ThreadsユーザーIDを取得できませんでした。");
  await setAppState(db, "threads_user_id", id);
  return id;
}

/**
 * テキスト投稿を公開する。コンテナ作成→(短い待機)→公開。
 * 公開は一時的な失敗に備えて数回リトライする。戻り値は投稿ID。
 */
export async function publishThreadsText(
  token: string,
  userId: string,
  text: string
): Promise<string> {
  const trimmed = text.length > THREADS_TEXT_LIMIT ? text.slice(0, THREADS_TEXT_LIMIT) : text;

  const created = await graphPost(`${GRAPH_BASE}/${userId}/threads`, {
    media_type: "TEXT",
    text: trimmed,
    access_token: token,
  });
  const creationId = String(created.id ?? "");
  if (!creationId) throw new Error("Threadsコンテナの作成に失敗しました。");

  // コンテナが公開可能になるまで少し待つ
  await sleep(2000);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const published = await graphPost(`${GRAPH_BASE}/${userId}/threads_publish`, {
        creation_id: creationId,
        access_token: token,
      });
      return String(published.id ?? creationId);
    } catch (e) {
      lastErr = e;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Threadsへの公開に失敗しました。");
}
