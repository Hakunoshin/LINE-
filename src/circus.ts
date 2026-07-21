// circus (circus-job.com) から求人情報を取得するヘルパー。
// circus側のAPI仕様に依存しないよう、JSONを返すエンドポイントを環境変数で受け取り、
// よくあるレスポンス形状(配列 / {jobs} / {data} / {results})を吸収して正規化する。
//
// 必要な設定:
//   CIRCUS_JOBS_URL   … 求人一覧を返すJSONエンドポイントのURL
//   CIRCUS_API_TOKEN  … (任意) Bearer認証トークン

export interface CircusJob {
  // 重複投稿を防ぐための安定したキー(idが無ければURL/タイトルから生成)
  key: string;
  title: string;
  company: string;
  location: string;
  salary: string;
  employmentType: string;
  url: string;
  description: string;
}

// レスポンス中のフィールド名の揺れを吸収するためのエイリアス一覧。
const FIELD_ALIASES: Record<keyof Omit<CircusJob, "key">, string[]> = {
  title: ["title", "job_title", "name", "position", "求人タイトル", "職種"],
  company: ["company", "company_name", "corporation", "企業名", "会社名"],
  location: ["location", "work_location", "area", "prefecture", "勤務地"],
  salary: ["salary", "annual_income", "income", "wage", "給与", "年収"],
  employmentType: ["employment_type", "employmentType", "job_type", "雇用形態"],
  url: ["url", "job_url", "detail_url", "link", "permalink"],
  description: ["description", "detail", "body", "summary", "職務内容", "仕事内容"],
};

function pickString(row: Record<string, unknown>, aliases: string[]): string {
  for (const key of aliases) {
    const v = row[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}

function extractArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    for (const key of ["jobs", "data", "results", "items", "求人"]) {
      const v = (data as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

function toJob(row: Record<string, unknown>): CircusJob {
  const job: Omit<CircusJob, "key"> = {
    title: pickString(row, FIELD_ALIASES.title),
    company: pickString(row, FIELD_ALIASES.company),
    location: pickString(row, FIELD_ALIASES.location),
    salary: pickString(row, FIELD_ALIASES.salary),
    employmentType: pickString(row, FIELD_ALIASES.employmentType),
    url: pickString(row, FIELD_ALIASES.url),
    description: pickString(row, FIELD_ALIASES.description),
  };

  // 重複判定用のキー: id系フィールド優先、無ければURL、それも無ければ会社名+タイトル
  const idValue = pickString(row, ["id", "job_id", "uuid", "code", "求人ID"]);
  const key = idValue || job.url || `${job.company}｜${job.title}`;

  return { key, ...job };
}

/** 求人をThreads投稿用のテキストに整形する。長すぎる説明文は投稿側で丸められる。 */
export function formatCircusJobPost(job: CircusJob): string {
  const lines = [`【新着求人】${job.title}`];
  if (job.company) lines.push(`🏢 ${job.company}`);
  if (job.location) lines.push(`📍 ${job.location}`);
  if (job.salary) lines.push(`💰 ${job.salary}`);
  if (job.employmentType) lines.push(`🕒 ${job.employmentType}`);

  if (job.description) {
    lines.push("");
    lines.push(job.description);
  }
  if (job.url) {
    lines.push("");
    lines.push(`▶ 詳細・ご応募はこちら`);
    lines.push(job.url);
  }
  lines.push("");
  lines.push("#求人 #転職 #キャリア");
  return lines.join("\n");
}

/** circusのエンドポイントから求人一覧を取得して正規化する。 */
export async function fetchCircusJobs(url: string, apiToken?: string): Promise<CircusJob[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`circus API error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as unknown;
  return extractArray(data)
    .map(toJob)
    // タイトルとキーが無い行は投稿できないので除外する
    .filter((job) => job.key && job.title);
}
