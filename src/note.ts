// note (note.com) 用の記事下書きをAI(Claude)で生成する。
//
// note には公式の投稿APIが無く、非公式APIも reCAPTCHA 等で不安定なため、
// ここでは「記事を生成してLINEに届ける」ところまでを行う。実際の公開は、
// 届いた本文をnoteのエディタに貼り付けて自分で行う運用(方式C)。

import Anthropic from "@anthropic-ai/sdk";
import { currentJstString } from "./dateParser";
import type { YouTubeVideo } from "./youtube";

export interface NoteArticle {
  title: string;
  body: string; // noteエディタに貼り付けやすいプレーンテキスト本文
  tags: string[];
  source?: YouTubeVideo; // 着想元の動画(あれば末尾に出典を付ける)
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

// note記事を生成する。videoを渡すと、その動画タイトルに着想を得たオリジナル記事を書く。
export async function generateArticle(
  apiKey: string,
  theme: string,
  opts: { video?: YouTubeVideo } = {}
): Promise<NoteArticle> {
  const client = new Anthropic({ apiKey });

  const userContent = opts.video
    ? [
        `現在(JST): ${currentJstString()}`,
        "",
        "以下は音声配信『芦名勇舗のASH RADIO』の本日の配信タイトルです。",
        `配信タイトル: ${opts.video.title}`,
        "",
        "このタイトル(テーマ)に着想を得て、あなた自身の考えを述べるオリジナルのnote記事を書いてください。",
        "重要な制約:",
        "- 配信の中身は不明なので、動画の内容を要約・引用したり、配信で言っていた等の断定はしない。",
        "- あくまで『このテーマについて自分はこう考える』という一次的な意見・経験として書く。",
        "- 書き手は人材業界のキャリアアドバイザー(営業・キャリア支援の実務経験あり)という設定で、",
        "  営業やキャリアの現場目線を自然に織り交ぜる。",
        "- 本文の冒頭で、今日のASH RADIOのテーマから着想を得た旨に軽く触れてよい(引用にはしない)。",
        "- 出典リンクは本文に書かない(システム側で末尾に付ける)。",
      ].join("\n")
    : `現在(JST): ${currentJstString()}\n\n次のテーマでnote記事を1本書いてください。\nテーマ: ${theme}`;

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: ARTICLE_SYSTEM,
    messages: [{ role: "user", content: userContent }],
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
  return { title, body, tags, source: opts.video };
}

// 記事本文(貼り付け用)を組み立てる。着想元の動画があれば末尾に出典を付ける。
export function buildNoteBody(article: NoteArticle): string {
  const tagLine =
    article.tags.length > 0 ? "\n\n" + article.tags.map((t) => `#${t.replace(/^#/, "")}`).join(" ") : "";
  const sourceLine = article.source
    ? `\n\n──────\n参考にした音声配信：芦名勇舗のASH RADIO「${article.source.title}」\n${article.source.url}`
    : "";
  return article.body + sourceLine + tagLine;
}

// 生成記事をLINEに貼り付けやすい1通のテキストに整形する。
export function formatArticleForLine(article: NoteArticle): string {
  return [
    `📝 note下書きができました`,
    `━━━━━━━━━━`,
    `【タイトル】`,
    article.title,
    ``,
    `【本文】`,
    buildNoteBody(article),
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
