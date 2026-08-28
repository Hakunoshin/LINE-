// Threads (Meta) 連携用ヘルパー。
// - OAuth2 でユーザーを連携し、長期アクセストークン(約60日)をD1に保存する
// - 失効が近づいたら自動でリフレッシュする(Threadsの長期トークンは何度でも延長可能)
// - テキスト投稿は「コンテナ作成 → 公開」の2段階APIで行う
// - 投稿文は Claude で自動生成する
//
// 参考: https://developers.facebook.com/docs/threads

import Anthropic from "@anthropic-ai/sdk";
import {
  getThreadsTokens,
  saveThreadsTokens,
  updateThreadsAccessToken,
  type ThreadsTokens,
} from "./db";

const GRAPH_BASE = "https://graph.threads.net";
const AUTH_BASE = "https://threads.net";
const API_VERSION = "v1.0";

// Threadsのテキスト投稿の上限は500文字
export const THREADS_TEXT_LIMIT = 500;

// 連携に必要なスコープ(基本情報の取得 + 投稿)
const SCOPES = ["threads_basic", "threads_content_publish"].join(",");

export function buildThreadsAuthUrl(appId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    response_type: "code",
  });
  return `${AUTH_BASE}/oauth/authorize?${params.toString()}`;
}

interface ShortLivedTokenResponse {
  access_token: string;
  user_id: string | number;
}

interface LongLivedTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // 秒。おおよそ 5,184,000(60日)
}

/**
 * OAuthのcodeを短期トークンに交換し、さらに長期トークンへ引き換えてD1に保存する。
 * ユーザー名も取得して保存する。
 */
export async function exchangeThreadsCode(
  appId: string,
  appSecret: string,
  redirectUri: string,
  code: string,
  db: D1Database
): Promise<{ username: string | null }> {
  // 1. code -> 短期トークン(約1時間)
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
    throw new Error(`Threads token exchange failed: ${shortRes.status} ${await shortRes.text()}`);
  }
  const short = (await shortRes.json()) as ShortLivedTokenResponse;

  // 2. 短期トークン -> 長期トークン(約60日)
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
  const expiresAtUtcIso = new Date(Date.now() + long.expires_in * 1000).toISOString();

  const userId = String(short.user_id);
  const username = await fetchUsername(long.access_token, userId);

  await saveThreadsTokens(db, {
    accessToken: long.access_token,
    expiresAtUtcIso,
    userId,
    username,
  });
  return { username };
}

async function fetchUsername(accessToken: string, userId: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ fields: "username", access_token: accessToken });
    const res = await fetch(`${GRAPH_BASE}/${API_VERSION}/${userId}?${params.toString()}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { username?: string };
    return data.username ?? null;
  } catch {
    return null;
  }
}

/**
 * 有効な長期アクセストークンを返す。失効が近ければリフレッシュしてから返す。
 * 未連携ならnull。
 */
export async function getValidThreadsToken(db: D1Database): Promise<ThreadsTokens | null> {
  const tokens = await getThreadsTokens(db);
  if (!tokens) return null;

  // 失効まで7日以内ならリフレッシュを試みる(長期トークンは24時間以上経過していれば延長可能)。
  const expMs = tokens.token_expires_at ? new Date(tokens.token_expires_at).getTime() : 0;
  const needsRefresh = !expMs || expMs <= Date.now() + 7 * 24 * 60 * 60 * 1000;
  if (!needsRefresh) return tokens;

  try {
    const params = new URLSearchParams({
      grant_type: "th_refresh_token",
      access_token: tokens.access_token,
    });
    const res = await fetch(`${GRAPH_BASE}/refresh_access_token?${params.toString()}`);
    if (res.ok) {
      const refreshed = (await res.json()) as LongLivedTokenResponse;
      const expiresAtUtcIso = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
      await updateThreadsAccessToken(db, refreshed.access_token, expiresAtUtcIso);
      return { ...tokens, access_token: refreshed.access_token, token_expires_at: expiresAtUtcIso };
    }
    // リフレッシュ失敗(トークンがまだ新しい等)。既存が失効前ならそのまま使う。
  } catch {
    // ネットワークエラー等。既存トークンで続行を試みる。
  }
  if (expMs && expMs <= Date.now()) return null; // 既に失効している
  return tokens;
}

/**
 * テキスト投稿を行う(コンテナ作成 → 公開の2段階)。成功時はThreads側の投稿IDを返す。
 */
export async function postThread(accessToken: string, userId: string, text: string): Promise<string> {
  // 1. メディアコンテナを作成
  const createRes = await fetch(`${GRAPH_BASE}/${API_VERSION}/${userId}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      media_type: "TEXT",
      text,
      access_token: accessToken,
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Threads container create failed: ${createRes.status} ${await createRes.text()}`);
  }
  const created = (await createRes.json()) as { id?: string };
  if (!created.id) {
    throw new Error("Threads container create failed: creation id が返却されませんでした");
  }

  // 2. コンテナを公開
  const publishRes = await fetch(`${GRAPH_BASE}/${API_VERSION}/${userId}/threads_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      creation_id: created.id,
      access_token: accessToken,
    }),
  });
  if (!publishRes.ok) {
    throw new Error(`Threads publish failed: ${publishRes.status} ${await publishRes.text()}`);
  }
  const published = (await publishRes.json()) as { id?: string };
  if (!published.id) {
    throw new Error("Threads publish failed: 投稿IDが返却されませんでした");
  }
  return published.id;
}

const DEFAULT_PERSONA =
  "『tetsu_ai_creater』というThreadsアカウントの発信者。生成AIの活用、業務自動化、個人開発、コンテンツ制作について、実践者ならではのリアルな気づきや具体的なノウハウを日本語で発信している。";

/** 環境変数からペルソナ(アカウントの人物像・発信テーマ)を解決する。 */
export function resolveThreadsPersona(raw: string | undefined): string {
  return raw && raw.trim() ? raw.trim() : DEFAULT_PERSONA;
}

function buildGenerationSystemPrompt(persona: string): string {
  return [
    "あなたはThreads(テキストSNS)向けの投稿文を書くプロのコピーライターです。",
    "",
    "【アカウントの人物像・発信テーマ】",
    persona,
    "",
    "【投稿の要件】",
    `- 全体で${THREADS_TEXT_LIMIT}文字以内。実際は120〜300文字程度が読みやすい。`,
    "- 冒頭の1行で思わず読みたくなるフック(問い・気づき・逆説など)を作る。",
    "- 具体性を大事にする。抽象論や当たり前の一般論だけで終わらせない。",
    "- 読者(発信テーマに関心がある人)にとっての学び・共感・行動のきっかけを1つ含める。",
    "- 自然な日本語の口調。過度な煽り・誇張・情報商材っぽさは避ける。",
    "- ハッシュタグは付けても1〜2個まで。無理に付けなくてよい。",
    "- 絵文字は使ってもよいが多用しない。",
    "",
    "【出力形式】",
    "- 投稿本文そのものだけを出力する。前置き・解説・引用符・「」で囲うことはしない。",
  ].join("\n");
}

/**
 * Threads投稿文を1本生成して返す。直近の投稿を渡すと内容の重複を避ける。
 */
export async function generateThreadsPost(
  apiKey: string,
  persona: string,
  recentTexts: string[]
): Promise<string> {
  const client = new Anthropic({ apiKey });

  const userMessage =
    recentTexts.length > 0
      ? [
          "直近で投稿した内容は以下です。テーマ・言い回し・切り口が重複しないように、新しい切り口で1本作成してください。",
          "",
          ...recentTexts.map((t, i) => `${i + 1}. ${t}`),
        ].join("\n")
      : "最初の投稿を1本作成してください。";

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    system: buildGenerationSystemPrompt(persona),
    messages: [{ role: "user", content: userMessage }],
  });

  let text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  // 生成物が引用符で囲まれてしまった場合に備えて除去する
  text = text.replace(/^["「『]/, "").replace(/["」』]$/, "").trim();

  if (!text) {
    throw new Error("投稿文の生成に失敗しました(空の応答)");
  }
  if (text.length > THREADS_TEXT_LIMIT) {
    text = text.slice(0, THREADS_TEXT_LIMIT - 1) + "…";
  }
  return text;
}
