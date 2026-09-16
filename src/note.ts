// note (note.com) 用の記事下書きをAI(Claude)で生成する。
//
// note には公式の投稿APIが無く、非公式APIも reCAPTCHA 等で不安定なため、
// ここでは「記事を生成してLINEに届ける」ところまでを行う。実際の公開は、
// 届いた本文をnoteのエディタに貼り付けて自分で行う運用(方式C)。

import Anthropic from "@anthropic-ai/sdk";
import { currentJstString } from "./dateParser";

export interface NoteArticle {
  title: string;
  body: string; // noteエディタに貼り付けやすいプレーンテキスト本文
  tags: string[];
}

const ARTICLE_SYSTEM = [
  "あなたはプロのnote記事ライターです。読者にとって有益で読みやすい記事を書きます。",
  "出力は必ず次のJSONオブジェクトのみ(前後に説明文やコードフェンスを付けない):",
  '{"title": string, "body": string, "tags": string[]}',
  "",
  "制約:",
  "- title: 30文字程度までの、思わずクリックしたくなる自然な日本語タイトル。記号の乱用はしない。",
  "- body: 記事本文。noteのエディタにそのまま貼り付ける前提のプレーンテキスト。",
  "  1200〜2000文字程度。導入→本論(小見出しを数個)→まとめ の構成。",
  "  見出しは行頭に『■ 』を付けた1行で表す。段落は空行で区切る。",
  "  HTMLタグやMarkdown記法(#, *, -, ```等)は使わない。箇条書きは『・』を使う。",
  "- tags: 記事に合うハッシュタグを3〜5個(#は付けない、日本語可)。",
  "- 誇張や不正確な断定を避け、一次情報が必要な具体的な数値・固有名詞は書かない。",
].join("\n");

// テーマからnote記事(タイトル・本文・タグ)を生成する。
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
  const body = String(parsed.body ?? "").trim();
  const tags = Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t)) : [];
  if (!title || !body) {
    throw new Error("記事生成の結果が不正でした(title/bodyが空)");
  }
  return { title, body, tags };
}

// 生成記事をLINEに貼り付けやすい1通のテキストに整形する。
export function formatArticleForLine(article: NoteArticle): string {
  const tagLine = article.tags.length > 0 ? "\n\n" + article.tags.map((t) => `#${t.replace(/^#/, "")}`).join(" ") : "";
  return [
    `📝 note下書きができました`,
    `━━━━━━━━━━`,
    `【タイトル】`,
    article.title,
    ``,
    `【本文】`,
    article.body + tagLine,
    `━━━━━━━━━━`,
    `↑ この本文をnoteに貼り付けて公開してください`,
  ].join("\n");
}

// AI応答からJSONオブジェクトを取り出す(コードフェンス等が付いた場合も救済)。
function extractJson(raw: string): Record<string, unknown> {
  const fenced = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? fenced.slice(start, end + 1) : fenced;
  return JSON.parse(candidate) as Record<string, unknown>;
}
