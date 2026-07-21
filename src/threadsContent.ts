// circusの求人をもとに「Threadsで伸びる」投稿文をClaudeで生成し、
// 過去投稿のエンゲージメント指標から「何が伸びるか」を分析して次に活かすモジュール。

import Anthropic from "@anthropic-ai/sdk";
import type { CircusJob } from "./circus";
import type { PostMetric } from "./db";
import { THREADS_TEXT_LIMIT } from "./threads";

function client(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

/**
 * 求人1件をThreads投稿文に変換する。
 * learnings(過去分析から得た「伸びる型」のメモ)があればそれを反映する。
 * 失敗時は呼び出し側でテンプレートにフォールバックする想定。
 */
export async function generateThreadsPost(
  apiKey: string,
  job: CircusJob,
  learnings: string | null
): Promise<string> {
  const jobLines = [
    `職種/タイトル: ${job.title}`,
    job.company && `企業: ${job.company}`,
    job.location && `勤務地: ${job.location}`,
    job.salary && `給与/年収: ${job.salary}`,
    job.employmentType && `雇用形態: ${job.employmentType}`,
    job.description && `詳細: ${job.description}`,
    job.url && `応募URL: ${job.url}`,
  ]
    .filter(Boolean)
    .join("\n");

  const system = [
    "あなたはThreadsで求人情報を発信する、SNS運用のプロの編集者です。",
    "与えられた求人1件を、Threadsで反応(閲覧・いいね・返信・リポスト)が伸びる投稿文にしてください。",
    "",
    "制約:",
    `- 全体で${THREADS_TEXT_LIMIT}文字以内。日本語。プレーンテキスト(Markdown記法は使わない)。`,
    "- 冒頭1行で目を引くフック。改行と絵文字は適度に使い、読みやすく。",
    "- 求人事実の誇張・捏造は禁止。与えられた情報の範囲で書く。",
    "- 応募URLがあれば本文中にそのまま含める。",
    "- 末尾に関連ハッシュタグを3〜5個。",
    "- 出力は投稿本文のみ。前置き・説明・コードブロックは不要。",
  ].join("\n");

  const userParts = [`# 求人情報\n${jobLines}`];
  if (learnings && learnings.trim()) {
    userParts.push(
      `# これまでの分析(伸びた投稿の傾向。可能な範囲で反映すること)\n${learnings.trim()}`
    );
  }

  const res = await client(apiKey).messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    system,
    messages: [{ role: "user", content: userParts.join("\n\n") }],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!text) throw new Error("生成結果が空でした");
  return text;
}

/**
 * 過去投稿の本文と指標から「どんな投稿が伸びるか」の改善メモを生成する。
 * このメモは次回以降の generateThreadsPost に渡され、投稿が改善されていく。
 */
export async function analyzePerformance(apiKey: string, posts: PostMetric[]): Promise<string> {
  const rows = posts
    .map((p, i) => {
      const engagement = `views=${p.views}, likes=${p.likes}, replies=${p.replies}, reposts=${p.reposts}, quotes=${p.quotes}`;
      return `【${i + 1}】(${engagement})\n${p.text}`;
    })
    .join("\n\n---\n\n");

  const system = [
    "あなたはSNS(Threads)分析の専門家です。",
    "以下は過去に投稿した求人ポストの本文と、それぞれのエンゲージメント指標です。",
    "指標の高い投稿・低い投稿を比較し、今後の投稿を改善するための具体的な示唆を日本語でまとめてください。",
    "",
    "観点の例: 冒頭フックの型、文の長さ、絵文字/改行の使い方、ハッシュタグの選び方、",
    "強調する求人要素(年収・勤務地・職種など)、投稿の構成。",
    "",
    "出力は箇条書き5〜8点、合計800文字以内。投稿本文をそのまま書くのではなく、",
    "『次にどう書くべきか』の指針だけを簡潔に書くこと。",
  ].join("\n");

  const res = await client(apiKey).messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    system,
    messages: [{ role: "user", content: `# 過去投稿と指標\n\n${rows}` }],
  });

  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
