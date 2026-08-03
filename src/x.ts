// X(旧Twitter)自動運用チーム。
// リサーチ(ネタ元/参考投稿) → バズの型の分析 → 集客用オリジナル投稿の作成、までをClaudeで行い、
// 生成した投稿案(ドラフト)はLINEで承認してからXへ投稿する。
// X APIキーが設定されていれば承認済みドラフトを自動投稿し、未設定なら手動投稿用に本文を返す。

import Anthropic from "@anthropic-ai/sdk";
import { currentJstString } from "./dateParser";
import type { XSeed } from "./db";

// Xの投稿上限は280(半角=1, 全角=2)。日本語なら全角140字が目安。
export const X_TARGET_JP_CHARS = 140;

export interface XApiCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export interface GeneratedPost {
  content: string;
  rationale: string;
}

export interface GenerateOptions {
  topic: string; // 発信テーマ(例: 転職・キャリア)
  accounts: string[]; // 参考アカウント(@付き)
  keywords: string[]; // キーワード/テーマ語
  references: string[]; // 参考にするバズ投稿の本文
  count: number; // 生成数
}

function buildSystemPrompt(topic: string): string {
  return [
    "あなたはX(旧Twitter)運用のプロフェッショナルチームです。依頼主は転職エージェントで、",
    `発信テーマは「${topic}」、最終目的は集客(見込み求職者のフォロー・プロフ誘導・DM/相談)です。`,
    `現在の日時: ${currentJstString()} (JST)`,
    "",
    "チームは次の役割で連携して1つの成果物(投稿案)を作ります:",
    "1) リサーチャー: 登録されたネタ元(参考アカウント・キーワード・参考投稿)から、その界隈で",
    "   伸びている投稿の『型』(フック/構成/CTA/フォーマット)を捉える。",
    "2) アナリスト: なぜ伸びるのか、どの層に刺さるのかを言語化する。",
    "3) ライター: その型を踏まえて、依頼主オリジナルの投稿を書く。",
    "",
    "厳守するルール:",
    "- 参考投稿は『型』だけを借りる。文章の丸写し・軽微な言い換えコピーは絶対にしない。",
    `- 本文は日本語で、全角換算で概ね${X_TARGET_JP_CHARS}字以内。1投稿=1メッセージ。`,
    "- 冒頭の1行で必ず引き(フック)を作る。転職・キャリアに悩む読者に具体的な有益さがある内容にする。",
    "- 集客導線を自然に入れる(例: プロフから相談/DM歓迎/リプで質問募集 等)。毎回同じ文言にしない。",
    "- 誇大表現・断定的な稼げる系・差別的表現・特定企業の誹謗はしない。信頼を損なわない誠実なトーン。",
    "- ハッシュタグは付けても1〜2個まで。絵文字は使いすぎない。",
    "- 投稿ごとに切り口(体験談/リスト/逆説/データ/Q&A 等)を変えて多様性を出す。",
    "",
    "必ず submit_posts ツールを使って投稿案を提出すること。",
  ].join("\n");
}

function buildUserPrompt(opts: GenerateOptions): string {
  const lines: string[] = [];
  lines.push(`投稿案を${opts.count}件つくってください。`);
  lines.push("");
  if (opts.accounts.length > 0) {
    lines.push("【参考アカウント(この界隈で伸びている発信者)】");
    for (const a of opts.accounts) lines.push(`- ${a}`);
    lines.push("");
  }
  if (opts.keywords.length > 0) {
    lines.push("【キーワード/テーマ】");
    lines.push(opts.keywords.join(" / "));
    lines.push("");
  }
  if (opts.references.length > 0) {
    lines.push("【参考にするバズ投稿(型だけ借りる。丸写し禁止)】");
    opts.references.forEach((r, i) => {
      lines.push(`(${i + 1}) ${r}`);
    });
    lines.push("");
  }
  if (opts.accounts.length === 0 && opts.keywords.length === 0 && opts.references.length === 0) {
    lines.push("(ネタ元の登録がまだないので、転職・キャリア領域でよく伸びる投稿の型を用いて作成してください)");
    lines.push("");
  }
  lines.push("各投稿には、どの型を使い・なぜ伸びる/集客に効くかの短い説明(rationale)も付けてください。");
  return lines.join("\n");
}

const SUBMIT_TOOL: Anthropic.Tool = {
  name: "submit_posts",
  description: "作成したX投稿案の一覧を提出する。",
  input_schema: {
    type: "object",
    properties: {
      posts: {
        type: "array",
        description: "投稿案の配列",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: `投稿本文。日本語、全角換算で概ね${X_TARGET_JP_CHARS}字以内。そのまま投稿できる完成形。`,
            },
            rationale: {
              type: "string",
              description: "どのバズの型を使い、なぜ伸びる/集客に効くかの短い説明(日本語)。",
            },
          },
          required: ["content", "rationale"],
        },
      },
    },
    required: ["posts"],
  },
};

/** ネタ元・参考投稿からオリジナルの投稿案を生成する。 */
export async function generateXDrafts(apiKey: string, opts: GenerateOptions): Promise<GeneratedPost[]> {
  const client = new Anthropic({ apiKey });
  // tool_choiceで submit_posts を強制するため、拡張thinkingは併用しない(APIが両立を許さないため)。
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    system: buildSystemPrompt(opts.topic),
    tools: [SUBMIT_TOOL],
    tool_choice: { type: "tool", name: "submit_posts" },
    messages: [{ role: "user", content: buildUserPrompt(opts) }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "submit_posts"
  );
  if (!toolUse) return [];

  const input = toolUse.input as { posts?: Array<{ content?: unknown; rationale?: unknown }> };
  const posts = Array.isArray(input.posts) ? input.posts : [];
  return posts
    .map((p) => ({
      content: String(p.content ?? "").trim(),
      rationale: String(p.rationale ?? "").trim(),
    }))
    .filter((p) => p.content.length > 0);
}

/** 参考にするネタ元を用途別の配列にまとめる。 */
export function groupSeeds(seeds: XSeed[]): { accounts: string[]; keywords: string[]; references: string[] } {
  const accounts: string[] = [];
  const keywords: string[] = [];
  const references: string[] = [];
  for (const s of seeds) {
    if (s.kind === "account") accounts.push(s.value);
    else if (s.kind === "keyword") keywords.push(s.value);
    else references.push(s.value);
  }
  return { accounts, keywords, references };
}

// ===== X API (v2) への投稿。OAuth 1.0a で署名する =====

export function getXCredentials(env: {
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_TOKEN_SECRET?: string;
}): XApiCredentials | null {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET } = env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_TOKEN_SECRET) return null;
  return {
    apiKey: X_API_KEY,
    apiSecret: X_API_SECRET,
    accessToken: X_ACCESS_TOKEN,
    accessTokenSecret: X_ACCESS_TOKEN_SECRET,
  };
}

// RFC3986 準拠のパーセントエンコード(OAuth署名で必須)
function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function toBase64(bytes: ArrayBuffer): string {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}

async function hmacSha1(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return toBase64(sig);
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

async function buildOAuthHeader(
  creds: XApiCredentials,
  method: string,
  url: string
): Promise<string> {
  // JSONボディのリクエストでは、署名対象は oauth_* パラメータ(とクエリ)のみ。
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: randomNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  const paramString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(oauthParams[k])}`)
    .join("&");

  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString),
  ].join("&");

  const signingKey = `${percentEncode(creds.apiSecret)}&${percentEncode(creds.accessTokenSecret)}`;
  const signature = await hmacSha1(signingKey, baseString);

  const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  const header =
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
      .join(", ");
  return header;
}

/** X API v2 でツイートを投稿する。成功したらツイートIDを返す。 */
export async function postToX(creds: XApiCredentials, text: string): Promise<string> {
  const url = "https://api.twitter.com/2/tweets";
  const authHeader = await buildOAuthHeader(creds, "POST", url);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`X API error: ${res.status} ${bodyText}`);
  }
  try {
    const json = JSON.parse(bodyText) as { data?: { id?: string } };
    return json.data?.id ?? "";
  } catch {
    return "";
  }
}

// ===== LINE表示用ヘルパー =====

export const X_HELP_TEXT = [
  "🐦 X運用チームの使い方",
  "",
  "1) ネタ元を登録する",
  "・Xアカウント <@id>  … 参考にする発信者を追加",
  "・Xキーワード <語>   … テーマ/検索語を追加(スペース区切り可)",
  "・バズ投稿を貼って「これ参考に」… その型でオリジナル投稿案を生成",
  "",
  "2) 投稿案をつくる",
  "・X案 / Xテスト  … 今すぐ投稿案を生成してLINEに送信(承認待ち)",
  "  毎日 8:00/12:00/17:00/21:00 にも自動生成して送ります",
  "",
  "3) 承認する",
  "・カードの「承認」ボタン、または「X承認 <番号>」",
  "・「X却下 <番号>」で却下、「X別案 <番号>」で作り直し",
  "",
  "4) 投稿される",
  "・X API連携済み → 承認するとXへ自動投稿",
  "・未連携 → 承認すると本文が届くので手動でコピー投稿",
  "",
  "そのほか:",
  "・X設定  … ネタ元・連携状況の確認",
  "・Xキュー … 承認待ち/承認済みの一覧",
  "・Xネタ元削除 <番号> … ネタ元を削除",
].join("\n");

export function buildXSettingsText(
  seeds: XSeed[],
  opts: { apiConnected: boolean; topic: string; generateTime: string; perRun: number }
): string {
  const grouped = groupSeeds(seeds);
  const lines: string[] = ["🐦 X運用チーム 設定", ""];
  lines.push(`発信テーマ: ${opts.topic}`);
  lines.push(`自動生成: 毎日 ${opts.generateTime} (JST) に${opts.perRun}件`);
  lines.push(`X投稿連携: ${opts.apiConnected ? "✅ 連携済み(承認で自動投稿)" : "未連携(承認後は手動投稿)"}`);
  lines.push("");
  lines.push("【参考アカウント】");
  const accountSeeds = seeds.filter((s) => s.kind === "account");
  lines.push(accountSeeds.length ? accountSeeds.map((s) => `#${s.id} ${s.value}`).join("\n") : "なし");
  lines.push("");
  lines.push("【キーワード】");
  const keywordSeeds = seeds.filter((s) => s.kind === "keyword");
  lines.push(keywordSeeds.length ? keywordSeeds.map((s) => `#${s.id} ${s.value}`).join("\n") : "なし");
  const refCount = grouped.references.length;
  if (refCount > 0) {
    lines.push("");
    lines.push(`【参考バズ投稿】${refCount}件登録`);
  }
  return lines.join("\n");
}

/** 承認/却下ボタン付きの投稿案カード(Flex bubble)を組み立てる。 */
export function buildDraftFlex(draft: { id: number; content: string; rationale: string | null }): {
  altText: string;
  contents: unknown;
} {
  const bodyContents: unknown[] = [
    { type: "text", text: `投稿案 #${draft.id}`, weight: "bold", size: "sm", color: "#1DA1F2" },
    { type: "separator", margin: "md" },
    { type: "text", text: draft.content, wrap: true, size: "md", margin: "md" },
  ];
  if (draft.rationale) {
    bodyContents.push({
      type: "text",
      text: `💡 ${draft.rationale}`,
      wrap: true,
      size: "xs",
      color: "#888888",
      margin: "md",
    });
  }

  const contents = {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: bodyContents,
    },
    footer: {
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "primary",
          color: "#1DA1F2",
          height: "sm",
          flex: 1,
          action: { type: "postback", label: "承認", data: `x_approve:${draft.id}`, displayText: `X承認 ${draft.id}` },
        },
        {
          type: "button",
          style: "secondary",
          height: "sm",
          flex: 1,
          action: { type: "postback", label: "別案", data: `x_regen:${draft.id}`, displayText: `X別案 ${draft.id}` },
        },
        {
          type: "button",
          style: "secondary",
          height: "sm",
          flex: 1,
          action: { type: "postback", label: "却下", data: `x_reject:${draft.id}`, displayText: `X却下 ${draft.id}` },
        },
      ],
    },
  };
  const alt = draft.content.length > 40 ? draft.content.slice(0, 40) + "…" : draft.content;
  return { altText: `X投稿案 #${draft.id}: ${alt}`, contents };
}
