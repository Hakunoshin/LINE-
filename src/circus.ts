// circus(circus-job.com)の「公開求人URL」から求人内容を取得するヘルパー。
// jobDetailPublicToken 付きのURLは、ページHTMLの __NEXT_DATA__ (Next.js) に
// props.pageProps.publicJob.job としてフル求人データが埋め込まれているので、
// ログインなしでサーバーサイドから取得・解析できる。

// ページ本文からcircusの公開求人URL(トークン付き)を抽出する。
const CIRCUS_URL_RE = /https?:\/\/circus-job\.com\/search\/\d+\?jobDetailPublicToken=[0-9a-fA-F-]+/g;

export function extractCircusJobUrls(text: string): string[] {
  const matches = text.match(CIRCUS_URL_RE) ?? [];
  return [...new Set(matches)];
}

export interface CircusJob {
  id: string;
  url: string;
  title: string;
  company: string;
  annualSalary: string;
  location: string;
  description: string;
  appealingPoints: string;
  benefitsNote: string;
}

function asText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// __NEXT_DATA__ 内の publicJob.job を正規化する。
function toCircusJob(url: string, job: Record<string, unknown>): CircusJob {
  const company = job.company as Record<string, unknown> | undefined;
  const salary = job.expectedAnnualSalary as { min?: number; max?: number } | undefined;

  let annualSalary = "";
  if (salary && (salary.min != null || salary.max != null)) {
    if (salary.min != null && salary.max != null) annualSalary = `${salary.min}〜${salary.max}万円`;
    else annualSalary = `${salary.min ?? salary.max}万円〜`;
  }

  // 勤務地: 詳細住所があれば冒頭を、無ければ勤務地コメントを使う。
  const location = asText(job.addressDetail) || asText(job.locationComments);

  return {
    id: String(job.id ?? ""),
    url,
    title: asText(job.name),
    company: asText(company?.name),
    annualSalary,
    location,
    description: asText(job.jobDescriptions),
    appealingPoints: asText(job.appealingPoints),
    benefitsNote: asText(job.payAndBenefits) || asText(job.otherBenefits),
  };
}

/** 公開求人URLを取得し、求人内容を解析して返す。取得/解析できなければ例外を投げる。 */
export async function fetchCircusPublicJob(url: string): Promise<CircusJob> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
  });
  if (!res.ok) {
    throw new Error(`circus fetch error: ${res.status}`);
  }
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) {
    throw new Error("求人データ(__NEXT_DATA__)が見つかりませんでした");
  }

  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
    throw new Error("求人データのJSON解析に失敗しました");
  }

  const job = (data as { props?: { pageProps?: { publicJob?: { job?: Record<string, unknown> } } } })
    ?.props?.pageProps?.publicJob?.job;
  if (!job || Object.keys(job).length === 0) {
    throw new Error("この求人は公開されていません(公開トークンが無効/期限切れの可能性)");
  }
  return toCircusJob(url, job);
}

/** 求人をClaudeに渡す/フォールバック整形するためのテキストにまとめる。 */
export function circusJobToText(job: CircusJob): string {
  return [
    `職種: ${job.title}`,
    job.company && `企業: ${job.company}`,
    job.annualSalary && `想定年収: ${job.annualSalary}`,
    job.location && `勤務地: ${job.location}`,
    job.appealingPoints && `アピールポイント:\n${job.appealingPoints}`,
    job.description && `仕事内容:\n${job.description}`,
    job.benefitsNote && `待遇・福利厚生:\n${job.benefitsNote}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
