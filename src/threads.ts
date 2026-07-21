// Threads (Meta) Graph API へのテキスト投稿ヘルパー。
// 投稿は2段階: (1) メディアコンテナを作成 → creation_id を得る
//              (2) その creation_id を publish して実際に投稿する。
// 必要な認証情報:
//   THREADS_USER_ID      … Threads の User ID (数値文字列)
//   THREADS_ACCESS_TOKEN … 長期アクセストークン (threads_basic, threads_content_publish 権限)

const THREADS_API_BASE = "https://graph.threads.net/v1.0";

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

  // (2) 公開
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
