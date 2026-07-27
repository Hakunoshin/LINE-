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
  holidays: string; // 年間休日日数
  minQualification: string; // 応募資格(未経験OK等)
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
  const holidaysNum = typeof job.numberOfHolidaysPerYear === "number" ? String(job.numberOfHolidaysPerYear) : "";

  return {
    id: String(job.id ?? ""),
    url,
    title: asText(job.name),
    company: asText(company?.name),
    annualSalary,
    location,
    holidays: holidaysNum,
    minQualification: asText(job.minimumQualification),
    description: asText(job.jobDescriptions),
    appealingPoints: asText(job.appealingPoints),
    benefitsNote: asText(job.payAndBenefits) || asText(job.otherBenefits),
  };
}

// 文字列中のstartBrace位置('{')から、対応する'}'までのバランスの取れた
// JSONオブジェクト文字列を切り出す(文字列内の括弧・エスケープを考慮)。
function extractBalancedObject(s: string, startBrace: number): string {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startBrace; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(startBrace, i + 1);
    }
  }
  throw new Error("求人データ(publicJob)の終端が見つかりませんでした");
}

/**
 * 公開求人URLを取得し、求人内容を解析して返す。取得/解析できなければ例外を投げる。
 * ページHTML(約500KB)全体をパースするとWorkerのCPU制限に触れうるため、
 * 必要な publicJob オブジェクト(数KB)だけを抜き出してパースする。
 */
export async function fetchCircusPublicJob(url: string): Promise<CircusJob> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
  });
  if (!res.ok) {
    throw new Error(`circus fetch error: ${res.status}`);
  }
  const html = await res.text();

  const key = '"publicJob":';
  const ki = html.indexOf(key);
  if (ki === -1) {
    throw new Error("求人データ(publicJob)が見つかりませんでした");
  }
  const braceStart = html.indexOf("{", ki + key.length);
  if (braceStart === -1) {
    throw new Error("求人データ(publicJob)の開始が見つかりませんでした");
  }

  let publicJob: { job?: Record<string, unknown> };
  try {
    publicJob = JSON.parse(extractBalancedObject(html, braceStart));
  } catch {
    throw new Error("求人データのJSON解析に失敗しました");
  }

  const job = publicJob?.job;
  if (!job || Object.keys(job).length === 0) {
    throw new Error("この求人は公開されていません(公開トークンが無効/期限切れの可能性)");
  }
  return toCircusJob(url, job);
}

/**
 * 求人をClaudeに渡す/フォールバック整形するためのテキストにまとめる。
 * 企業名は投稿に出さない方針のため、ここには含めない(タイトル等に混ざる企業名は生成側で匿名化する)。
 */
export function circusJobToText(job: CircusJob): string {
  return [
    `職種: ${job.title}`,
    job.annualSalary && `想定年収: ${job.annualSalary}`,
    job.holidays && `年間休日: ${job.holidays}日`,
    job.minQualification && `応募資格: ${job.minQualification}`,
    job.appealingPoints && `アピールポイント:\n${job.appealingPoints}`,
    job.description && `仕事内容:\n${job.description}`,
    job.benefitsNote && `待遇・福利厚生:\n${job.benefitsNote}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
