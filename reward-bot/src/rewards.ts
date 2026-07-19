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

const CIRCUS_API = "https://api.circus-job.com/api";

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

// ---- circus ログインAPI (任意・要認証情報) ------------------------------
//
// 注意: circus の内部APIはSPAのバンドルから推定したもので、公式仕様ではない。
// エンドポイント名(login-v2 / get-job-search-v2)・認証ヘッダ
// (x-circus-authentication-token) は判明しているが、レスポンスの
// フィールド名(理論年収)は実アカウントでの確認が必要。取得できないときは
// null を返し、理論年収は手入力にフォールバックする。

export interface CircusData {
  theoryIncomeMan: number | null;
  rewardRaw: string | null;
}

async function circusLogin(email: string, password: string): Promise<string | null> {
  try {
    const res = await fetch(`${CIRCUS_API}/login-v2`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, isAdmin: false }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return data?.token ?? data?.data?.token ?? null;
  } catch {
    return null;
  }
}

/** circus から企業の理論年収(と分かれば報酬)を取得。失敗時は null。 */
async function fetchCircus(
  env: { CIRCUS_EMAIL?: string; CIRCUS_PASSWORD?: string },
  companyName: string
): Promise<CircusData | null> {
  if (!env.CIRCUS_EMAIL || !env.CIRCUS_PASSWORD) return null;
  const token = await circusLogin(env.CIRCUS_EMAIL, env.CIRCUS_PASSWORD);
  if (!token) return null;
  try {
    const url = new URL(`${CIRCUS_API}/get-job-search-v2`);
    url.searchParams.set("keyword", companyName);
    const res = await fetch(url.toString(), {
      headers: { "x-circus-authentication-token": token },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    // レスポンス構造は要確認。理論年収らしき数値を緩く探索する。
    const income = extractTheoryIncome(data);
    return { theoryIncomeMan: income, rewardRaw: null };
  } catch {
    return null;
  }
}

/** circusレスポンスから理論年収(万円)らしき値を緩く探す (フィールド名が不確実なため)。 */
function extractTheoryIncome(data: unknown): number | null {
  let found: number | null = null;
  const visit = (node: any, keyHint: string) => {
    if (found != null || node == null) return;
    if (typeof node === "number") {
      if (/理論年収|theor|annualIncome|expectedIncome|income/i.test(keyHint) && node > 100) {
        // 円単位で来る場合は万円に換算
        found = node >= 1_000_000 ? Math.round(node / 10_000) : node;
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) visit(v, keyHint);
    } else if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) visit(v, k);
    }
  };
  visit(data, "");
  return found;
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
    return { platform, company: src.company, rewardRaw: src.rewardRaw, bestYenMan: yen, note };
  };

  results.push(build("circus", null)); // circusの報酬額は現状取得しないためプレースホルダ
  // circusの理論年収だけ取れたことは theorySource に反映済み。
  results.push(build("peterpan", matchCompany(peterpanSources, companyName)));
  results.push(build("trueaim", matchCompany(trueaim, companyName)));

  // circus の報酬は未対応なので、円が取れない circus は末尾扱い。
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
  if (found.length === 0) {
    lines.push("いずれの媒体にも該当求人が見つかりませんでした。");
    lines.push("企業名をフルネームで送ってみてください。");
    return lines.join("\n");
  }

  let rank = 1;
  for (const r of result.results) {
    if (r.company == null) {
      lines.push(`・${r.platform}: 該当求人なし`);
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
  } else if (result.theoryIncomeMan == null) {
    lines.push("");
    lines.push("※ 料率型のみのため、理論年収を送ると金額で比較できます (例: 理論年収500万)");
  }

  return lines.join("\n");
}
