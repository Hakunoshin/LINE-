// note (note.com) への自動投稿クライアント。
//
// ⚠️ 注意: note には公式の投稿APIが存在しません。ここではブラウザが使っている
// 非公式の内部API (/api/v1/text_notes) を利用します。仕様は予告なく変わる可能性が
// あり、動かなくなることがあります。
//
// 認証について:
//   noteのログイン(/api/v1/sessions/sign_in)は現在 reCAPTCHA が必須になっており、
//   メール+パスワードによるプログラム的な自動ログインはできません。そのため
//   「ブラウザで一度ログインして取得したセッションCookie(_note_session_v5)」を
//   Secret(NOTE_SESSION_COOKIE)として保存し、それを使い回して投稿します。
//   Cookieはいずれ失効するので、その際は再取得して差し替える必要があります。
//
//   取得方法(PC Chrome例):
//     1. https://note.com にログイン
//     2. DevTools → Application → Cookies → https://note.com
//     3. `_note_session_v5` の値をコピー
//     4. `npx wrangler secret put NOTE_SESSION_COOKIE` に貼り付け

import Anthropic from "@anthropic-ai/sdk";
import { currentJstString } from "./dateParser";

const NOTE_API_BASE = "https://note.com/api";

export interface NoteArticle {
  title: string;
  bodyHtml: string;
  tags: string[];
}

export interface NotePostResult {
  ok: boolean;
  status: "published" | "draft";
  noteId: string | null;
  url: string | null;
  detail: string;
}

// note内部APIを叩くときの共通ヘッダー。ブラウザからのリクエストに寄せる。
function noteHeaders(sessionCookie: string, xsrfToken: string | null): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Origin: "https://note.com",
    Referer: "https://note.com/notes/new",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
    Cookie: `_note_session_v5=${sessionCookie}`,
  };
  if (xsrfToken) headers["X-XSRF-TOKEN"] = xsrfToken;
  return headers;
}

// Set-Cookieヘッダーから指定Cookieの値を取り出す(あれば)。
function readSetCookie(res: Response, name: string): string | null {
  // Workersでは getSetCookie() が使える場合がある
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = typeof anyHeaders.getSetCookie === "function"
    ? anyHeaders.getSetCookie()
    : [res.headers.get("set-cookie") ?? ""];
  for (const c of cookies) {
    const m = c.match(new RegExp(`${name}=([^;]+)`));
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

// 書き込み系リクエストの前にXSRF-TOKEN Cookieを取得しておく(あれば付与する)。
async function fetchXsrfToken(sessionCookie: string): Promise<string | null> {
  try {
    const res = await fetch("https://note.com/", {
      headers: {
        Cookie: `_note_session_v5=${sessionCookie}`,
        "User-Agent": "Mozilla/5.0",
      },
    });
    return readSetCookie(res, "XSRF-TOKEN");
  } catch {
    return null;
  }
}

// 空の下書きを作成し、note内部IDを得る。
async function createDraft(sessionCookie: string, xsrf: string | null): Promise<string> {
  const res = await fetch(`${NOTE_API_BASE}/v1/text_notes`, {
    method: "POST",
    headers: noteHeaders(sessionCookie, xsrf),
    body: JSON.stringify({ template_key: null }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`下書き作成に失敗 (${res.status}): ${text.slice(0, 300)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`下書き作成の応答が不正: ${text.slice(0, 300)}`);
  }
  const id = (json as { data?: { id?: number | string } })?.data?.id;
  if (id === undefined || id === null) {
    throw new Error(`下書きIDを取得できませんでした: ${text.slice(0, 300)}`);
  }
  return String(id);
}

// 下書き本文を保存し、publish=true なら公開する。
async function saveNote(
  sessionCookie: string,
  xsrf: string | null,
  noteId: string,
  article: NoteArticle,
  publish: boolean
): Promise<string> {
  const url = new URL(`${NOTE_API_BASE}/v1/text_notes/${noteId}`);
  if (publish) url.searchParams.set("publish", "true");

  const payload = {
    name: article.title,
    body: article.bodyHtml,
    status: publish ? "published" : "draft",
    // ハッシュタグは {"hashtag":{"name":"..."}} 形式で渡す
    hashtags: article.tags.map((t) => ({ hashtag: { name: t.replace(/^#/, "") } })),
    index: publish, // 公開時のみ検索インデックス対象にする
    is_refstopped: false,
    disable_comment: false,
    free_body: null,
    limited: false,
  };

  const res = await fetch(url.toString(), {
    method: "PUT",
    headers: noteHeaders(sessionCookie, xsrf),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${publish ? "公開" : "下書き保存"}に失敗 (${res.status}): ${text.slice(0, 300)}`);
  }
  return text;
}

// note.comに記事を投稿する。publish=falseなら下書き保存のみ。
export async function postArticle(
  sessionCookie: string,
  article: NoteArticle,
  publish: boolean
): Promise<NotePostResult> {
  const xsrf = await fetchXsrfToken(sessionCookie);
  const noteId = await createDraft(sessionCookie, xsrf);
  await saveNote(sessionCookie, xsrf, noteId, article, publish);
  return {
    ok: true,
    status: publish ? "published" : "draft",
    noteId,
    url: publish ? `https://note.com/notes/${noteId}` : `https://note.com/notes/${noteId}/edit`,
    detail: publish ? "公開しました" : "下書き保存しました",
  };
}

// ---- 記事本文のAI生成 --------------------------------------------------

const ARTICLE_SYSTEM = [
  "あなたはプロのnote記事ライターです。読者にとって有益で読みやすい記事を書きます。",
  "出力は必ず次のJSONオブジェクトのみ(前後に説明文やコードフェンスを付けない):",
  '{"title": string, "body_html": string, "tags": string[]}',
  "",
  "制約:",
  "- title: 30文字程度までの、思わずクリックしたくなる自然な日本語タイトル。記号の乱用はしない。",
  "- body_html: 記事本文をシンプルなHTMLで。使用可能タグは <h2> <h3> <p> <ul> <li> <ol> <blockquote> <strong> のみ。",
  "  1200〜2000文字程度。導入→本論(見出し数個)→まとめ の構成。",
  "  <html><body>などのラッパーや、style属性・classは付けない。",
  "- tags: 記事に合うハッシュタグを3〜5個(#は付けない、日本語可)。",
  "- 誇張や不正確な断定を避け、一次情報が必要な数値は書かない。",
].join("\n");

// テーマからnote記事(タイトル・本文HTML・タグ)を生成する。
export async function generateArticle(apiKey: string, theme: string): Promise<NoteArticle> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: ARTICLE_SYSTEM,
    messages: [
      {
        role: "user",
        content: `現在(JST): ${currentJstString()}\n\n次のテーマでnote記事を1本書いてください。\nテーマ: ${theme}`,
      },
    ],
  });

  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const parsed = extractJson(raw);
  const title = String(parsed.title ?? "").trim();
  const bodyHtml = String(parsed.body_html ?? "").trim();
  const tags = Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t)) : [];
  if (!title || !bodyHtml) {
    throw new Error("記事生成の結果が不正でした(title/body_htmlが空)");
  }
  return { title, bodyHtml, tags };
}

// AI応答からJSONオブジェクトを取り出す(コードフェンス等が付いた場合も救済)。
function extractJson(raw: string): Record<string, unknown> {
  const fenced = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? fenced.slice(start, end + 1) : fenced;
  return JSON.parse(candidate) as Record<string, unknown>;
}
