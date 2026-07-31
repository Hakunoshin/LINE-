// LINE Messaging API とのやり取り（署名検証・reply・push）を扱うヘルパー。

const LINE_API_BASE = "https://api.line.me/v2/bot";

function base64Encode(bytes: ArrayBuffer): string {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) {
    binary += String.fromCharCode(view[i]);
  }
  return btoa(binary);
}

/**
 * x-line-signature ヘッダーを channel secret で検証する。
 * リクエストボディは生のテキストである必要がある（JSON.parse前のもの）。
 */
export async function verifyLineSignature(
  rawBody: string,
  signature: string | null,
  channelSecret: string
): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = base64Encode(digest);
  return expected === signature;
}

export interface LineTextMessageEvent {
  type: string;
  replyToken?: string;
  source: { type: string; userId?: string };
  message?: { type: string; text?: string };
  postback?: { data: string };
}

export interface LineWebhookBody {
  events: LineTextMessageEvent[];
}

async function callLineApi(path: string, accessToken: string, body: unknown): Promise<void> {
  const res = await fetch(`${LINE_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LINE API error (${path}): ${res.status} ${text}`);
  }
}

export function replyText(accessToken: string, replyToken: string, text: string): Promise<void> {
  return callLineApi("/message/reply", accessToken, {
    replyToken,
    messages: [{ type: "text", text }],
  });
}

export function pushText(accessToken: string, userId: string, text: string): Promise<void> {
  return callLineApi("/message/push", accessToken, {
    to: userId,
    messages: [{ type: "text", text }],
  });
}

/** Flexメッセージ(ボタン付きカード)をreplyで送る。contentsはLINE Flexのbubble等。 */
export function replyFlex(
  accessToken: string,
  replyToken: string,
  altText: string,
  contents: unknown
): Promise<void> {
  return callLineApi("/message/reply", accessToken, {
    replyToken,
    messages: [{ type: "flex", altText, contents }],
  });
}
