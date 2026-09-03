// Threadsに自動投稿する本文をClaudeで生成する。
// 求人・自社PR系(人材紹介 / キャリア支援)のテーマで、Threadsに馴染む短文を作る。

import Anthropic from "@anthropic-ai/sdk";
import { currentJstString } from "./dateParser";
import { THREADS_TEXT_LIMIT } from "./threads";

// 上限500文字ちょうどだと切れて不自然になるので少し手前で丸める
const SOFT_LIMIT = 480;

function buildSystemPrompt(): string {
  return [
    "あなたは人材紹介会社『株式会社OneRep 人材事業部』のキャリアアドバイザー本人として、",
    "Threads(スレッズ)アカウントを運用しています。フォロワーは転職を考えている求職者や、",
    "キャリアに悩む20〜30代が中心です。",
    `現在の日時: ${currentJstString()} (JST)`,
    "",
    "目的:",
    "- 求職者に役立つ情報を届けてフォロワーとの信頼を築き、最終的に転職相談・求人応募につなげる",
    "- 求人・自社(人材紹介サービス)の魅力を、押し付けがましくなく自然に伝える",
    "",
    "投稿の作り方:",
    "- テーマは『求人紹介・転職支援・キャリア相談』を軸に、毎回違う切り口にする",
    "  例) 転職の悩みへの共感、面接や職務経歴書のコツ、非公開求人の存在、キャリアアドバイザーに相談する価値、",
    "      未経験歓迎の求人動向、業界の待遇トレンド、無料相談の案内 など",
    "- Threadsらしく、口語で親しみやすいトーン。1〜3個の短い段落。適度に改行を入れる",
    "- 絵文字は使っても0〜2個まで。使いすぎない",
    "- 末尾にハッシュタグを1〜3個(例: #転職 #キャリア相談 #求人)。多用しない",
    "- 具体的な社名・実在の求人名・給与額など、事実確認が必要な断定はしない",
    "- 相談導線は自然に(例:「気になる方はプロフィールから」「DMで気軽にどうぞ」等)。毎回は入れなくてよい",
    "",
    "厳守事項:",
    `- 本文は全体で${THREADS_TEXT_LIMIT}文字以内。できれば${SOFT_LIMIT}文字以内`,
    "- Markdown記法(見出し#, 太字**, 箇条書き記号-や*)は使わない。プレーンテキストのみ",
    "- 出力は投稿本文だけ。前置き・説明・引用符・「投稿:」などのラベルは一切付けない",
  ].join("\n");
}

/** Threads投稿本文を1つ生成して返す。recentPostsは重複回避のため直近投稿を渡す。 */
export async function generateThreadsPost(
  apiKey: string,
  recentPosts: string[]
): Promise<string> {
  const client = new Anthropic({ apiKey });

  const recentBlock = recentPosts.length
    ? "直近に投稿した本文(内容・切り口が重複しないようにする):\n" +
      recentPosts.map((p, i) => `${i + 1}. ${p.replace(/\n/g, " ")}`).join("\n")
    : "(過去の投稿はまだありません)";

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    system: buildSystemPrompt(),
    messages: [
      {
        role: "user",
        content: `${recentBlock}\n\n上記と重複しない、新しいThreads投稿を1つだけ作成してください。本文のみを出力してください。`,
      },
    ],
  });

  let text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  // 念のため、モデルが付けがちな囲み引用符を除去
  if (text.length >= 2 && /^["「『]/.test(text) && /["」』]$/.test(text)) {
    text = text.slice(1, -1).trim();
  }

  if (text.length > THREADS_TEXT_LIMIT) {
    text = text.slice(0, SOFT_LIMIT).trim() + "…";
  }

  return text;
}
