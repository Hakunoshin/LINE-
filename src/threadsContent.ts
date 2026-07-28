// circusの求人をもとに「Threadsで伸びる」投稿文をClaudeで生成し、
// 過去投稿のエンゲージメント指標から「何が伸びるか」を分析して次に活かすモジュール。

import Anthropic from "@anthropic-ai/sdk";
import type { PostMetric } from "./db";
import type { CircusJob } from "./circus";
import { truncateForThreads } from "./threads";

function client(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

// 投稿末尾の導線(CTA)。'dm' はDMへ、'comment' はコメントへ誘導する。
export type CtaType = "dm" | "comment";

const CTA_INSTRUCTION: Record<CtaType, string> = {
  dm: "末尾は、興味を持った人に『DM』で連絡するよう促す一文で締める(例: 気になる方はお気軽にDMください📩)。",
  comment:
    "末尾は、興味を持った人に『コメント』で一言もらうよう促す一文で締める(例: 気になる方はコメントに『詳細希望』と一言ください💬)。",
};

const CTA_FALLBACK_TEXT: Record<CtaType, string> = {
  dm: "気になる方はお気軽にDMください📩",
  comment: "気になる方はコメントに「詳細希望」と一言ください💬",
};

// 企業名(および前後の「株式会社」等)を文中から除去する。
function stripCompany(text: string, company: string): string {
  if (!text) return "";
  let t = text;
  if (company) {
    // 完全一致と、「株式会社」を外した社名本体の両方を消す。
    const core = company.replace(/株式会社|有限会社|合同会社|\(株\)|（株）/g, "").trim();
    for (const term of [company, core].filter((s) => s && s.length >= 2)) {
      t = t.split(term).join("");
    }
  }
  return t;
}

// 空白・改行を詰めて指定文字数で丸める。
function snippet(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").replace(/^[\s■◆◎●★・\-–—]+/, "").trim();
  return t.length <= max ? t : t.slice(0, max).trim() + "…";
}

// タイトルを短いフックにする(区切り文字までを採り、企業名を除去)。最終フォールバック用。
function shortHook(title: string, company: string): string {
  const t = stripCompany(title, company).replace(/\s+/g, " ").trim();
  const cut = t.split(/[｜|／/]/)[0].trim();
  return snippet(cut || t, 34);
}

// アピール文/仕事内容から、1行目のフックになる強い短文を1つ取り出す。
// 先頭の装飾(＼POINT／、【PRポイント①】、＜…＞、≪…≫、記号・絵文字)を剥がし、最初の一文を採る。
function pickHook(text: string, company: string): string {
  if (!text) return "";
  let t = stripCompany(text, company).replace(/\s+/g, " ").trim();
  let prev = "";
  while (t !== prev) {
    prev = t;
    t = t.replace(/^[\s＼／\\｜|■◆◎●★☆▶✔✅☑🔶🔷🔸🔹👀📢💡🎯・:：\-–—「」『』]+/, "");
    t = t.replace(/^(?:【[^】]{0,16}】|＜[^＞]{0,16}＞|≪[^≫]{0,16}≫|POINT|ポイント)[!！]?\s*/i, "");
  }
  t = t.trim();
  if (!t) return "";
  let seg = t.slice(0, 48);
  const cut = seg.slice(8).search(/[。．！!？?■【＼＜≪★◎●▶🔶🔷]/);
  if (cut >= 0) {
    const end = 8 + cut;
    seg = /[。．！!？?]/.test(seg[end]) ? seg.slice(0, end + 1) : seg.slice(0, end);
  }
  seg = seg.replace(/[。．\s]+$/, "").trim();
  if (seg.length < 7) return "";
  if (/^(ポイント|PR|概要|募集|仕事内容)/i.test(seg)) return "";
  return snippet(seg, 44);
}

// アピール本文から、求人票に書かれた訴求フレーズを最大n個抽出する(引用に使う)。
function extractAppealPhrases(text: string, company: string, n: number): string[] {
  if (!text) return [];
  return stripCompany(text, company)
    .split(/[\n。！!、／/｜|]|【[^】]*】|＜|＞|≪|≫|[◎●★☆◆▶✔✅☑🔶🔷🔸🔹＼]/)
    .map((s) => s.replace(/^[\s：:・\-–—「」『』]+/, "").replace(/[「」『』]/g, "").trim())
    .filter(
      (s) =>
        s.length >= 7 &&
        s.length <= 22 &&
        !/^(ポイント|PR|POINT|概要)/i.test(s) &&
        !/(について|における)$/.test(s) &&
        !/[のにをでとがはやな、]$/.test(s)
    )
    .slice(0, n);
}

// APIキーが無い/生成に失敗したときのテンプレート投稿。
// 1行目は求人票の訴求文から作った刺さるフック、続けて想定年収＋求人票から引用した訴求ポイント。
// Threadsは短い方が伸びるため簡潔に。勤務地・企業名は入れない。
export function buildTemplatePost(job: CircusJob, cta: CtaType): string {
  const appeal = job.appealingPoints || "";
  const hook =
    pickHook(appeal, job.company) ||
    pickHook(job.description, job.company) ||
    shortHook(job.title, job.company) ||
    "注目の求人👀";

  const points: string[] = [];
  if (job.annualSalary) points.push(`💰 想定年収 ${job.annualSalary}`);
  for (const phrase of extractAppealPhrases(appeal, job.company, 3)) {
    if (points.length >= 3) break;
    if (!hook.includes(phrase)) points.push(`✅ ${phrase}`);
  }
  if (points.length < 3 && job.holidays) points.push(`🗓 年間休日${job.holidays}日`);
  if (points.length < 3 && /未経験|不問/.test(job.minQualification)) points.push("🔰 未経験歓迎");

  const lines: string[] = [hook, "", ...points.slice(0, 3), "", CTA_FALLBACK_TEXT[cta], "", "#求人 #転職 #キャリア"];
  return truncateForThreads(lines.join("\n"));
}

/**
 * 求人票(自由記述の本文)をThreads投稿文に変換する。
 * learnings(過去分析から得た「伸びる型」のメモ)があればそれを反映する。
 * cta で末尾の導線(DM or コメント)を指定する。
 * 失敗時は呼び出し側で formatRawJobPost にフォールバックする想定。
 */
export async function generateThreadsPostFromText(
  apiKey: string,
  jobText: string,
  learnings: string | null,
  cta: CtaType,
  bannedCompany?: string
): Promise<string> {
  const system = [
    "あなたはThreadsで求人情報を発信する、SNS運用のプロの編集者です。",
    "与えられた求人票1件を、Threadsで反応(閲覧・いいね・返信・リポスト)が伸びる投稿文にしてください。",
    "",
    "制約:",
    "- Threadsは短い投稿ほど伸びるので、全体を短くまとめる(目安150〜250文字、長くても300文字以内)。",
    "- 日本語。プレーンテキスト(Markdown記法は使わない)。",
    "- 1行目は最重要。求人票の『アピールポイント』の一番刺さる要素を活かして、思わず読みたくなる強いフックにする。",
    "- そのあと訴求ポイントを3つ程度、箇条書き(絵文字1つ+短い一言)で。求人票に書かれた訴求文を引用・活用する。",
    "- 求人事実の誇張・捏造は禁止。与えられた求人票の情報の範囲で書く。",
    "- 企業名・会社名は本文に一切出さない。必要なら『上場企業グループ』『業界大手』等に匿名化する。",
    "- 勤務地・住所は入れない。",
    bannedCompany ? `- 特に「${bannedCompany}」という固有名詞は絶対に本文に含めない。` : "",
    `- ${CTA_INSTRUCTION[cta]}`,
    "- CTAの直後に関連ハッシュタグを3〜4個。",
    "- 出力は投稿本文のみ。前置き・説明・コードブロックは不要。",
  ]
    .filter(Boolean)
    .join("\n");

  const userParts = [`# 求人票\n${jobText.trim()}`];
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
      const cta = p.cta_type ? `, CTA=${p.cta_type}` : "";
      return `【${i + 1}】(${engagement}${cta})\n${p.text}`;
    })
    .join("\n\n---\n\n");

  const system = [
    "あなたはSNS(Threads)分析の専門家です。",
    "以下は過去に投稿した求人ポストの本文と、それぞれのエンゲージメント指標です。",
    "各投稿にはCTA(末尾の導線)の種別も付いています: dm=DM誘導 / comment=コメント誘導。",
    "指標の高い投稿・低い投稿を比較し、今後の投稿を改善するための具体的な示唆を日本語でまとめてください。",
    "",
    "観点の例: 冒頭フックの型、文の長さ、絵文字/改行の使い方、ハッシュタグの選び方、",
    "強調する求人要素(年収・勤務地・職種など)、投稿の構成、そしてCTA(dm/comment)による反応の違い。",
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
