// 企業求人の「成約報酬」を circus / peterpan / trueaim の3媒体から取得し、
// 一番報酬が高い媒体を判定するモジュール。
//
// - peterpan: 公開Notion + 公開Googleスプレッドシート (認証不要)
// - trueaim : 公開Notion (認証不要)
// - circus  : ログイン制API (CIRCUS_EMAIL / CIRCUS_PASSWORD を設定したときのみ)。
//             主に「理論年収」の取得元。未設定/失敗時は理論年収を手入力で補う。
//
// 報酬の書き方は2パターン:
//   1) 固定額型  … 「100万」「120万円」「一律60万円（税別）」など
//   2) 料率型    … 「35%」「理論年収の35％」「年収の35%」など (理論年収 × 料率)
// 「新卒：90万円 中途：年収の35%」のような混在も、金額・料率を全部拾って最大値で比較する。

export interface RewardSource {
  platform: string; // "circus" | "peterpan" | "trueaim"
  company: string; // 媒体側に載っている企業名
  rewardRaw: string; // 報酬欄の生テキスト
}

export interface ParsedReward {
  yensMan: number[]; // 固定額(万円)。範囲は上限を採用
  ratesPct: number[]; // 料率(%)。理論年収に対する率とみなす
}

export interface PlatformResult {
  platform: string;
  company: string | null; // マッチした企業名 (見つからなければ null)
  rewardRaw: string | null;
  bestYenMan: number | null; // 換算後の成約報酬(万円)。理論年収不明の料率のみだと null
  note: string; // 換算の根拠 (例: "理論年収500万×35%")
}

export interface ComparisonResult {
  query: string;
  theoryIncomeMan: number | null;
  theorySource: string | null; // "circus" | "手入力" | null
  results: PlatformResult[]; // bestYenMan 降順
}

// ---- 媒体ごとのデータソース設定 ----------------------------------------

const PETERPAN_NOTION = {
  host: "peterpan-inc.notion.site",
  collectionId: "91788db6-ef1a-4ec8-9347-1205062a03e9",
  viewId: "3d9b97ea-b33c-41fc-a7d5-0f236a934dcb",
  companyCol: "名前",
  rewardCol: "成果報酬",
};

const TRUEAIM_NOTION = {
  host: "dot-orca-0dd.notion.site",
  collectionId: "81e209ac-893e-8327-9156-87bad5eb2542",
  viewId: "dc9209ac-893e-82c4-839b-08099d445e3d",
  companyCol: "企業名",
  rewardCol: "報酬",
};

const PETERPAN_SHEET = {
  id: "11D_w8T7OprLgq_CDLIq4gr5mYvPvreBGPR6b0tdMrxk",
  gid: "119043748",
  companyHeaderIndex: 0, // 1列目が企業名
  rewardHeader: "ご紹介料",
};

// circus のログインは api-v2 の公開エンドポイント、データ取得は同一オリジンBFF (/api/*)。
const CIRCUS_LOGIN_URL = "https://api-v2.circus-job.com/public/sessions";
const CIRCUS_JOBSEARCH_URL = "https://circus-job.com/api/jobSearch";

// 媒体ごとの取り分係数。成約報酬にこの係数を掛けた額で比較する。
// (peterpan は 0.8倍、trueaim は 0.9倍、circus は等倍)
const PLATFORM_MULTIPLIER: Record<string, number> = {
  circus: 1,
  peterpan: 0.8,
  trueaim: 0.9,
};

// ---- テキスト正規化・パース --------------------------------------------

/** 全角→半角・波ダッシュ統一など。 */
function normalizeText(s: string): string {
  return s.normalize("NFKC").replace(/[〜～]/g, "~");
}

/** 企業名を比較用に正規化 (株式会社などの法人格・記号・空白を除去)。 */
export function normalizeCompany(name: string): string {
  return normalizeText(name)
    .replace(/(株式会社|有限会社|合同会社|合資会社|一般社団法人|株)/g, "")
    .replace(/[()（）「」【】・,、.\s　]/g, "")
    .toLowerCase();
}

/** 報酬欄テキストから固定額(万円)と料率(%)を抽出する。 */
export function parseReward(raw: string): ParsedReward {
  const s = normalizeText(raw);
  const yensMan: number[] = [];
  const ratesPct: number[] = [];

  // 「50~100万」「120万円」など。範囲は上限を採用。
  const yenRe = /(\d+(?:\.\d+)?)\s*(?:~\s*(\d+(?:\.\d+)?))?\s*万/g;
  let m: RegExpExecArray | null;
  while ((m = yenRe.exec(s)) !== null) {
    const hi = m[2] ? parseFloat(m[2]) : parseFloat(m[1]);
    if (!Number.isNaN(hi)) yensMan.push(hi);
  }

  // 「35%」など。人材紹介の料率は理論年収に対する率とみなす。
  const rateRe = /(\d+(?:\.\d+)?)\s*%/g;
  while ((m = rateRe.exec(s)) !== null) {
    const r = parseFloat(m[1]);
    if (!Number.isNaN(r)) ratesPct.push(r);
  }

  return { yensMan, ratesPct };
}

/** パース結果と理論年収から成約報酬(万円)の最大値を求める。料率のみで理論年収不明なら null。 */
function bestYenMan(p: ParsedReward, theoryIncomeMan: number | null): { yen: number | null; note: string } {
  const candidates: { yen: number; note: string }[] = [];
  for (const y of p.yensMan) candidates.push({ yen: y, note: `${y}万円` });
  if (theoryIncomeMan != null) {
    for (const r of p.ratesPct) {
      candidates.push({ yen: (theoryIncomeMan * r) / 100, note: `理論年収${theoryIncomeMan}万×${r}%` });
    }
  }
  if (candidates.length === 0) {
    // 料率はあるが理論年収不明
    if (p.ratesPct.length > 0) {
      const r = Math.max(...p.ratesPct);
      return { yen: null, note: `理論年収×${r}%(理論年収未定)` };
    }
    return { yen: null, note: "報酬不明" };
  }
  candidates.sort((a, b) => b.yen - a.yen);
  return { yen: Math.round(candidates[0].yen * 10) / 10, note: candidates[0].note };
}

// ---- Notion 公開API ----------------------------------------------------

interface NotionRow {
  [col: string]: string;
}

/** 公開Notionコレクションの全行を取得する。 */
async function fetchNotionCollection(cfg: {
  host: string;
  collectionId: string;
  viewId: string;
}): Promise<NotionRow[]> {
  const res = await fetch(`https://${cfg.host}/api/v3/queryCollection?src=initial_load`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      collection: { id: cfg.collectionId },
      collectionView: { id: cfg.viewId },
      loader: {
        type: "reducer",
        reducers: { collection_group_results: { type: "results", limit: 300 } },
        searchQuery: "",
        userTimeZone: "Asia/Tokyo",
      },
    }),
  });
  if (!res.ok) throw new Error(`Notion ${cfg.host} HTTP ${res.status}`);
  const data = (await res.json()) as any;
  const rm = data?.recordMap;
  if (!rm) return [];

  // スキーマ (列ID -> 列名)
  const collWrap = Object.values(rm.collection ?? {})[0] as any;
  const collVal = collWrap?.value?.value ?? collWrap?.value;
  const schema = collVal?.schema ?? {};
  const idToName: Record<string, string> = {};
  for (const [cid, sc] of Object.entries<any>(schema)) idToName[cid] = sc?.name ?? cid;

  const textOf = (prop: unknown): string => {
    if (!Array.isArray(prop)) return prop == null ? "" : String(prop);
    return prop.map((seg: any) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : "")).join("");
  };

  const rows: NotionRow[] = [];
  for (const b of Object.values<any>(rm.block ?? {})) {
    const v = b?.value?.value ?? b?.value;
    if (v?.type !== "page") continue;
    const props = v?.properties ?? {};
    const row: NotionRow = {};
    for (const [cid, val] of Object.entries(props)) {
      row[idToName[cid] ?? cid] = textOf(val);
    }
    rows.push(row);
  }
  return rows;
}

async function fetchPeterpanNotion(): Promise<RewardSource[]> {
  const rows = await fetchNotionCollection(PETERPAN_NOTION);
  return rows
    .map((r) => ({
      platform: "peterpan",
      company: (r[PETERPAN_NOTION.companyCol] ?? "").trim(),
      rewardRaw: (r[PETERPAN_NOTION.rewardCol] ?? "").trim(),
    }))
    .filter((s) => s.company && s.rewardRaw);
}

async function fetchTrueaimNotion(): Promise<RewardSource[]> {
  const rows = await fetchNotionCollection(TRUEAIM_NOTION);
  return rows
    .map((r) => ({
      platform: "trueaim",
      company: (r[TRUEAIM_NOTION.companyCol] ?? "").trim(),
      rewardRaw: (r[TRUEAIM_NOTION.rewardCol] ?? "").trim(),
    }))
    .filter((s) => s.company && s.rewardRaw);
}

// ---- Googleスプレッドシート (公開CSV) ----------------------------------

/** RFC4180準拠の簡易CSVパーサ (引用符内の改行・カンマに対応)。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // skip
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function fetchPeterpanSheet(): Promise<RewardSource[]> {
  const url = `https://docs.google.com/spreadsheets/d/${PETERPAN_SHEET.id}/export?format=csv&gid=${PETERPAN_SHEET.gid}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`peterpan sheet HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0];
  const rewardIdx = header.findIndex((h) => h.trim() === PETERPAN_SHEET.rewardHeader);
  if (rewardIdx < 0) return [];
  const out: RewardSource[] = [];
  for (const r of rows.slice(1)) {
    const company = (r[PETERPAN_SHEET.companyHeaderIndex] ?? "").trim();
    const rewardRaw = (r[rewardIdx] ?? "").trim();
    if (company && rewardRaw) out.push({ platform: "peterpan", company, rewardRaw });
  }
  return out;
}

// ---- circus ログインAPI (要 CIRCUS_EMAIL / CIRCUS_PASSWORD) --------------
//
// circus の内部API (SPAバンドルから判明):
//   - POST login-v2          : { email, password } でログイン → token
//   - GET  get-job-search-v2 : qJson=[{option,keyword,logicType}] で求人検索
//   認証は header "x-circus-authentication-token: <token>" + セッションcookie。
// 求人オブジェクトの主なフィールド:
//   - theoreticalAnnualIncome : 理論年収 (円 or 万円)
//   - commissionFee           : { commissionFeePrice(固定額), commissionFeePercentage(料率) }
//   - company                 : { name }
// 認証情報が未設定/失敗時は null を返し、理論年収は手入力にフォールバックする。

export interface CircusData {
  theoryIncomeMan: number | null;
  rewardRaw: string | null; // circus自身の成果報酬 (固定額 or 「理論年収の◯%」)
}

interface CircusAuth {
  token: string;
  cookie: string;
}

function extractCookieValue(cookieHeader: string, name: string): string | null {
  const m = cookieHeader.match(new RegExp(`${name}=([^;]+)`));
  return m ? m[1] : null;
}

async function circusLogin(email: string, password: string): Promise<CircusAuth | null> {
  try {
    const res = await fetch(CIRCUS_LOGIN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://circus-job.com" },
      // forceLogin: 既に別セッションがあっても強制ログインする (409回避)
      body: JSON.stringify({ email, password, forceLogin: true }),
    });
    if (!res.ok) return null;
    const getSetCookie = (res.headers as { getSetCookie?: () => string[] }).getSetCookie;
    const setCookie = getSetCookie ? getSetCookie.call(res.headers).join("; ") : res.headers.get("set-cookie") ?? "";
    const data = (await res.json().catch(() => ({}))) as any;
    const token = data?.token ?? extractCookieValue(setCookie, "access_token");
    if (!token) return null;
    // 取得したトークンを access_token cookie としても後続リクエストに付与する
    const accessCookie = extractCookieValue(setCookie, "access_token") ?? String(token);
    return { token: String(token), cookie: `access_token=${accessCookie}` };
  } catch {
    return null;
  }
}

/** 同一オリジンBFFの jobSearch を企業名キーワードで叩き、求人ノードを収集する。 */
async function circusSearchJobs(auth: CircusAuth, companyName: string): Promise<any[]> {
  const url = new URL(CIRCUS_JOBSEARCH_URL);
  const q = url.searchParams;
  // qJson は [and, or, excludeAnd, excludeOr] の4要素。各要素はJSON文字列。
  q.append("qJson[0]", JSON.stringify({ option: 1, keyword: companyName, logicType: "and" }));
  q.append("qJson[1]", JSON.stringify({ option: 1, keyword: "", logicType: "or" }));
  q.append("qJson[2]", JSON.stringify({ option: 1, keyword: "", logicType: "excludeAnd" }));
  q.append("qJson[3]", JSON.stringify({ option: 1, keyword: "", logicType: "excludeOr" }));
  q.append("selectionDaysIncludingDuringMeasurement[0]", "included");
  q.append("page", "1");
  q.append("orderBy", "recommendScore");
  q.append("order", "desc");
  const res = await fetch(url.toString(), {
    headers: {
      "x-circus-authentication-token": auth.token,
      cookie: auth.cookie,
      origin: "https://circus-job.com",
    },
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  return collectJobNodes(data);
}

/** レスポンスを再帰的に走査し、company と commissionFee を持つノードを求人とみなす。 */
function collectJobNodes(data: any): any[] {
  const out: any[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const v of node) visit(v);
      return;
    }
    if (node.company && ("commissionFee" in node || "expectedAnnualSalary" in node)) {
      out.push(node);
    }
    for (const v of Object.values(node)) visit(v);
  };
  visit(data);
  return out;
}

function circusCompanyName(job: any): string {
  const c = job?.company;
  if (!c) return "";
  return typeof c === "object" ? String(c.name ?? c.companyName ?? "") : String(c);
}

/** 円 or 万円で来る金額を万円に正規化する (1,200,000 → 120 / 120 → 120)。 */
function toMan(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 10000 ? Math.round(n / 10000) : Math.round(n);
}

// 求人の理論年収(万円)を求める。
// circus の commissionFee = { fee: 手数料率%, calcValue: 手数料額(円) } なので
//   理論年収(円) = calcValue ÷ fee × 100。取れなければ想定年収の下限で代用する。
function circusTheoryMan(job: any): number | null {
  const cf = job?.commissionFee;
  const fee = Number(cf?.fee);
  const calc = Number(cf?.calcValue);
  if (Number.isFinite(fee) && fee > 0 && Number.isFinite(calc) && calc > 0) {
    // 理論年収(円)=calcValue/fee*100 → 万円換算は ÷10000。まとめると calcValue/fee/100。
    return Math.round(calc / fee / 100);
  }
  const min = job?.expectedAnnualSalary?.min;
  return toMan(min);
}

// circus 経由の成約報酬(円→表示用テキスト)。commissionFee.calcValue が手数料額。
function circusRewardRaw(job: any): string | null {
  const cf = job?.commissionFee;
  const calcMan = toMan(cf?.calcValue);
  if (calcMan) return `${calcMan}万円`;
  const fee = Number(cf?.fee);
  if (Number.isFinite(fee) && fee > 0) return `理論年収の${fee}%`;
  return null;
}

/** circus から企業の理論年収と成果報酬を取得。失敗時は null。 */
async function fetchCircus(
  env: { CIRCUS_EMAIL?: string; CIRCUS_PASSWORD?: string },
  companyName: string
): Promise<CircusData | null> {
  if (!env.CIRCUS_EMAIL || !env.CIRCUS_PASSWORD) return null;
  const auth = await circusLogin(env.CIRCUS_EMAIL, env.CIRCUS_PASSWORD);
  if (!auth) return null;
  try {
    const jobs = await circusSearchJobs(auth, companyName);
    if (jobs.length === 0) return { theoryIncomeMan: null, rewardRaw: null };
    const target = normalizeCompany(companyName);
    const job =
      jobs.find((j) => {
        const n = normalizeCompany(circusCompanyName(j));
        return n && (n === target || n.includes(target) || target.includes(n));
      }) ?? jobs[0];
    return { theoryIncomeMan: circusTheoryMan(job), rewardRaw: circusRewardRaw(job) };
  } catch {
    return null;
  }
}

// ---- 比較本体 ----------------------------------------------------------

function matchCompany(sources: RewardSource[], target: string): RewardSource | null {
  const t = normalizeCompany(target);
  if (!t) return null;
  // 完全一致 → 部分一致
  let hit = sources.find((s) => normalizeCompany(s.company) === t);
  if (hit) return hit;
  hit = sources.find((s) => {
    const c = normalizeCompany(s.company);
    return c.includes(t) || t.includes(c);
  });
  return hit ?? null;
}

/**
 * 指定企業の成約報酬を3媒体で比較する。
 * theoryIncomeOverrideMan が与えられればそれを優先、無ければ circus から取得を試みる。
 */
export async function compareReward(
  env: { CIRCUS_EMAIL?: string; CIRCUS_PASSWORD?: string },
  companyName: string,
  theoryIncomeOverrideMan?: number | null
): Promise<ComparisonResult> {
  const [peterpanNotion, peterpanSheet, trueaim, circus] = await Promise.all([
    fetchPeterpanNotion().catch(() => [] as RewardSource[]),
    fetchPeterpanSheet().catch(() => [] as RewardSource[]),
    fetchTrueaimNotion().catch(() => [] as RewardSource[]),
    fetchCircus(env, companyName).catch(() => null),
  ]);

  // 理論年収: 手入力 > circus
  let theoryIncomeMan: number | null = theoryIncomeOverrideMan ?? null;
  let theorySource: string | null = theoryIncomeMan != null ? "手入力" : null;
  if (theoryIncomeMan == null && circus?.theoryIncomeMan != null) {
    theoryIncomeMan = circus.theoryIncomeMan;
    theorySource = "circus";
  }

  const peterpanSources = [...peterpanNotion, ...peterpanSheet];
  const results: PlatformResult[] = [];

  const build = (platform: string, src: RewardSource | null): PlatformResult => {
    if (!src) return { platform, company: null, rewardRaw: null, bestYenMan: null, note: "該当求人なし" };
    const parsed = parseReward(src.rewardRaw);
    const { yen, note } = bestYenMan(parsed, theoryIncomeMan);
    const mult = PLATFORM_MULTIPLIER[platform] ?? 1;
    // 成約報酬に媒体ごとの取り分係数を掛けた額で比較する。
    const adjYen = yen == null ? null : Math.round(yen * mult * 10) / 10;
    const adjNote = mult === 1 ? note : `${note} ×${mult}`;
    return { platform, company: src.company, rewardRaw: src.rewardRaw, bestYenMan: adjYen, note: adjNote };
  };

  const circusSrc: RewardSource | null = circus?.rewardRaw
    ? { platform: "circus", company: companyName, rewardRaw: circus.rewardRaw }
    : null;
  results.push(build("circus", circusSrc));
  results.push(build("peterpan", matchCompany(peterpanSources, companyName)));
  results.push(build("trueaim", matchCompany(trueaim, companyName)));

  results.sort((a, b) => {
    if (a.bestYenMan == null && b.bestYenMan == null) return 0;
    if (a.bestYenMan == null) return 1;
    if (b.bestYenMan == null) return -1;
    return b.bestYenMan - a.bestYenMan;
  });

  return { query: companyName, theoryIncomeMan, theorySource, results };
}

/** 比較結果を LINE 用のプレーンテキストに整形する。 */
export function formatComparison(result: ComparisonResult): string {
  const lines: string[] = [];
  lines.push(`💰 成約報酬 比較: ${result.query}`);
  if (result.theoryIncomeMan != null) {
    lines.push(`理論年収: ${result.theoryIncomeMan}万円 (${result.theorySource})`);
  } else {
    lines.push(`理論年収: 未設定 (料率型は金額換算できません)`);
  }
  lines.push("");

  const found = result.results.filter((r) => r.company != null);

  let rank = 1;
  for (const r of result.results) {
    if (r.company == null) {
      lines.push(`・${r.platform}: 該当なし`);
      continue;
    }
    const amount = r.bestYenMan != null ? `${r.bestYenMan}万円` : "金額未定";
    lines.push(`${rank}. ${r.platform}  ${amount}  (${r.note})`);
    lines.push(`   └ ${(r.rewardRaw ?? "").replace(/\s*\n\s*/g, " / ")}`);
    rank++;
  }

  const top = result.results.find((r) => r.bestYenMan != null);
  if (top) {
    lines.push("");
    lines.push(`👑 一番高いのは ${top.platform} (${top.bestYenMan}万円)`);
  } else if (found.length === 0) {
    lines.push("");
    lines.push("全媒体で該当なし。企業名をフルネームで送ってみてください。");
  } else if (result.theoryIncomeMan == null) {
    lines.push("");
    lines.push("※ 料率型のみのため、理論年収を送ると金額で比較できます (例: 理論年収500万)");
  }

  return lines.join("\n");
}
