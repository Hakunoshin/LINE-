import { Hono } from "hono";
import { verifyLineSignature, replyText, pushText, type LineWebhookBody } from "./line";
import {
  addReminder,
  listPendingReminders,
  deleteReminder,
  getDueReminders,
  markNotified,
  getAppState,
  setAppState,
  isJobPosted,
  markJobPosted,
} from "./db";
import { parseReminderInput, formatJstDateTime, currentJstHm, jstDateKey, jstTodayRangeUtc, jstTomorrowRangeUtc, jstDateOnlyUtc } from "./dateParser";
import {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  getValidAccessToken,
  listTodayEvents,
  listIncompleteTasks,
  insertTask,
} from "./google";
import { handleWithAi } from "./ai";
import { circusLogin, fetchCircusJobs, formatCircusJobPost, type CircusJob } from "./circus";
import { postThreadsText } from "./threads";

export interface Env {
  DB: D1Database;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
  // 未設定の場合は誰からのメッセージにも応答する。
  // 「自分だけの」エージェントにするには自分のLINE userIdを設定すること。
  ALLOWED_USER_ID?: string;
  // Google Cloud ConsoleでOAuthクライアント作成後に設定する。
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // Anthropic APIキー。設定するとコマンド以外のメッセージをClaudeがAIとして応答する。
  ANTHROPIC_API_KEY?: string;
  // 毎日ダイジェストを送る時刻 (JST, "HH:MM"形式のカンマ区切り)。未設定なら DEFAULT_DIGEST_TIMES。
  DAILY_DIGEST_TIME_JST?: string;
  // --- circus求人 → Threads自動投稿 ---
  // circusの求人一覧を返すJSONエンドポイント。未設定なら自動投稿は動かない。
  CIRCUS_JOBS_URL?: string;
  // circusにログインするためのエンドポイントURLと認証情報(secret)。
  // これらを設定すると、求人取得前に自動ログインしてセッションを使う。
  CIRCUS_LOGIN_URL?: string;
  CIRCUS_EMAIL?: string;
  CIRCUS_PASSWORD?: string;
  // 静的なBearerトークンを直接持っている場合はこちら(ログイン不要になる)。
  CIRCUS_API_TOKEN?: string;
  // ThreadsのUser ID と長期アクセストークン。両方揃わないと投稿しない。
  THREADS_USER_ID?: string;
  THREADS_ACCESS_TOKEN?: string;
  // 自動投稿を実行するJSTの時刻 ("HH:MM"のカンマ区切り)。未設定なら DEFAULT_THREADS_AUTOPOST_TIMES。
  THREADS_AUTOPOST_TIME_JST?: string;
  // 1回の実行で投稿する求人の最大件数。未設定なら DEFAULT_THREADS_MAX_POSTS。
  THREADS_MAX_POSTS_PER_RUN?: string;
}

const DEFAULT_DIGEST_TIMES = ["07:30", "13:00", "18:00"];
const TASK_COMMAND = "【タスク】";

// 企業提案の準備タスク自動生成(当日分)
const PROPOSAL_MARKER = "【企業提案】";
const RESEARCH_MARKER = "【企業調べ】";
const PROPOSAL_PREP_TIME_JST = "07:30";

// 面接対策の準備タスク自動生成(前日分)
const INTERVIEW_MARKER = "【面接対策】";
const INTERVIEW_PREFIX = "面接対策準備";
const INTERVIEW_PREP_TIME_JST = "07:30";

// 翌日の予定を前日夜に予告する時刻 (JST)
const TOMORROW_PREVIEW_TIME_JST = "21:00";

// circus求人 → Threads自動投稿。既定は9:00/15:00/21:00 JSTの1日3回。
const DEFAULT_THREADS_AUTOPOST_TIMES = ["09:00", "15:00", "21:00"];
const DEFAULT_THREADS_MAX_POSTS = 1;
const THREADS_POST_COMMAND = "求人投稿";

const HELP_TEXT = [
  "使えるコマンド:",
  "・追加 <日時> <内容>  例) 追加 明日9:00 ゴミ出し",
  "  日時は「今日/明日/明後日」「HH:MM」「YYYY-MM-DD」「M/D」などが使えます",
  "  Google連携済みならGoogle Tasksにも追加されます",
  "・一覧  … 未通知のリマインダーを表示",
  "・削除 <ID>  … リマインダーを削除",
  "・今日 / 【タスク】  … 今日の予定とGoogle Tasksの未完了ToDoを表示",
  "・求人投稿  … circusの新着求人をThreadsに今すぐ投稿(設定済みの場合)",
  "・ヘルプ  … このメッセージを表示",
  "",
  "上記以外のメッセージはAI(Claude)が応答します。",
  "例)「明日の朝ゴミ出しリマインドして」「今日って何かあったっけ？」",
  "",
  `毎日 ${DEFAULT_DIGEST_TIMES.join("/")} (JST) に自動配信されます`,
].join("\n");

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("personal-line-agent is running"));

app.get("/oauth/start", (c) => {
  const { GOOGLE_CLIENT_ID } = c.env;
  if (!GOOGLE_CLIENT_ID) {
    return c.text("GOOGLE_CLIENT_ID が設定されていません。", 500);
  }
  const redirectUri = new URL("/oauth/callback", c.req.url).toString();
  return c.redirect(buildGoogleAuthUrl(GOOGLE_CLIENT_ID, redirectUri));
});

app.get("/oauth/callback", async (c) => {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = c.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return c.text("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が設定されていません。", 500);
  }
  const code = c.req.query("code");
  const error = c.req.query("error");
  if (error) {
    return c.text(`Google認証がキャンセルまたは失敗しました: ${error}`, 400);
  }
  if (!code) {
    return c.text("codeパラメータがありません。", 400);
  }
  const redirectUri = new URL("/oauth/callback", c.req.url).toString();
  try {
    await exchangeCodeForTokens(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirectUri, code, c.env.DB);
  } catch (e) {
    return c.text(`Google連携に失敗しました: ${(e as Error).message}`, 500);
  }
  return c.text("Google連携が完了しました。このタブは閉じて大丈夫です。");
});

app.post("/webhook", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-line-signature");
  const valid = await verifyLineSignature(rawBody, signature ?? null, c.env.LINE_CHANNEL_SECRET);
  if (!valid) {
    return c.text("invalid signature", 401);
  }

  const body = JSON.parse(rawBody) as LineWebhookBody;

  for (const event of body.events) {
    if (event.type !== "message" || event.message?.type !== "text" || !event.replyToken) {
      continue;
    }
    const userId = event.source.userId;
    if (!userId) continue;

    if (c.env.ALLOWED_USER_ID && userId !== c.env.ALLOWED_USER_ID) {
      // 本人以外からのメッセージには応答しない
      continue;
    }

    // 自動配信(push)の送信先として、メッセージ送信者のuserIdを記録しておく。
    // ALLOWED_USER_IDが未設定でも、一度でもメッセージを送れば自動配信が有効になる。
    await setAppState(c.env.DB, "owner_user_id", userId);

    const text = event.message.text ?? "";
    const baseUrl = new URL(c.req.url).origin;
    const reply = await handleCommand(c.env, userId, text, baseUrl);
    await replyText(c.env.LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, reply);
  }

  return c.text("ok");
});

// 自動配信(push)の送信先を決める。ALLOWED_USER_ID優先、無ければ記録済みのowner。
async function getPushTargetUserId(env: Env): Promise<string | null> {
  if (env.ALLOWED_USER_ID) return env.ALLOWED_USER_ID;
  return await getAppState(env.DB, "owner_user_id");
}

async function getAccessTokenOrNull(env: Env): Promise<string | null> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  try {
    return await getValidAccessToken(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.DB);
  } catch {
    return null;
  }
}

async function buildTodayDigest(accessToken: string): Promise<string> {
  const now = new Date();
  const { startUtcIso, endUtcIso } = jstTodayRangeUtc(now);
  const [events, tasks] = await Promise.all([
    listTodayEvents(accessToken, startUtcIso, endUtcIso),
    listIncompleteTasks(accessToken),
  ]);

  const lines = ["📅 今日の予定・ToDo"];
  lines.push("");
  lines.push("【予定】");
  if (events.length === 0) {
    lines.push("なし");
  } else {
    for (const ev of events) {
      const time = ev.isAllDay ? "終日" : formatJstDateTime(ev.startIso).split(" ")[1];
      lines.push(`・${time} ${ev.summary}`);
    }
  }
  lines.push("");
  lines.push("【未完了ToDo】");
  if (tasks.length === 0) {
    lines.push("本日タスクなし");
  } else {
    for (const t of tasks) {
      lines.push(`・${t.title}`);
    }
  }
  return lines.join("\n");
}

async function handleCommand(env: Env, userId: string, text: string, baseUrl: string): Promise<string> {
  const trimmed = text.trim();

  if (trimmed === "ヘルプ" || trimmed === "help") {
    return HELP_TEXT;
  }

  if (trimmed === "一覧" || trimmed === "リスト") {
    const reminders = await listPendingReminders(env.DB, userId);
    if (reminders.length === 0) {
      return "登録中のリマインダーはありません。";
    }
    return reminders
      .map((r) => `#${r.id} ${formatJstDateTime(r.due_at)} ${r.content}`)
      .join("\n");
  }

  if (trimmed === "テスト配信" || trimmed === "テスト") {
    // 自動配信と同じpush送信を今すぐ試す(送信先登録の確認用)
    const accessToken = await getAccessTokenOrNull(env);
    if (!accessToken) {
      return `Googleと連携されていません。\n${baseUrl}/oauth/start から連携してください。`;
    }
    try {
      const digest = await buildTodayDigest(accessToken);
      await pushText(env.LINE_CHANNEL_ACCESS_TOKEN, userId, digest);
      return "テスト配信をプッシュ送信しました。この直後に届く別メッセージが自動配信と同じ形式です。";
    } catch (e) {
      return `テスト配信に失敗しました: ${(e as Error).message}`;
    }
  }

  if (trimmed === THREADS_POST_COMMAND || trimmed === "Threads投稿") {
    if (!getThreadsConfig(env)) {
      return "circus/Threadsの連携が未設定です。CIRCUS_JOBS_URL・THREADS_USER_ID・THREADS_ACCESS_TOKEN を設定してください。";
    }
    const result = await postNewCircusJobsToThreads(env, getThreadsMaxPosts(env));
    if (result.posted.length > 0) {
      const lines = [`Threadsに${result.posted.length}件投稿しました。`];
      for (const job of result.posted) {
        lines.push(`・${job.title}${job.company ? ` (${job.company})` : ""}`);
      }
      return lines.join("\n");
    }
    if (result.error) {
      return `投稿できませんでした: ${result.error}`;
    }
    if (result.fetched === 0) {
      return "circusから求人を取得できませんでした(0件)。";
    }
    return `新着の求人はありませんでした(取得${result.fetched}件はすべて投稿済み)。`;
  }

  if (trimmed === "今日" || trimmed === TASK_COMMAND) {
    const accessToken = await getAccessTokenOrNull(env);
    if (!accessToken) {
      return `Googleと連携されていません。以下のURLにブラウザでアクセスして連携してください。\n${baseUrl}/oauth/start`;
    }
    try {
      return await buildTodayDigest(accessToken);
    } catch (e) {
      return `Googleからの取得に失敗しました: ${(e as Error).message}`;
    }
  }

  if (trimmed.startsWith("削除")) {
    const idStr = trimmed.replace("削除", "").trim();
    const id = Number(idStr);
    if (!idStr || Number.isNaN(id)) {
      return "削除するリマインダーのIDを指定してください。例: 削除 3";
    }
    const deleted = await deleteReminder(env.DB, userId, id);
    return deleted ? `#${id} を削除しました。` : `#${id} は見つかりませんでした。`;
  }

  if (trimmed.startsWith("追加")) {
    const rest = trimmed.replace("追加", "").trim();
    const parsed = parseReminderInput(rest);
    if ("error" in parsed) {
      return parsed.error;
    }
    const id = await addReminder(env.DB, userId, parsed.content, parsed.dueAtUtcIso);

    let googleNote = "";
    const accessToken = await getAccessTokenOrNull(env);
    if (accessToken) {
      try {
        const timePart = formatJstDateTime(parsed.dueAtUtcIso).split(" ")[1];
        await insertTask(accessToken, `[${timePart}] ${parsed.content}`, jstDateOnlyUtc(parsed.dueAtUtcIso));
        googleNote = "\n(Google Tasksにも追加しました)";
      } catch (e) {
        googleNote = `\n(Google Tasksへの追加に失敗しました: ${(e as Error).message})`;
      }
    }

    return `リマインダーを登録しました。\n#${id} ${formatJstDateTime(parsed.dueAtUtcIso)} ${parsed.content}${googleNote}`;
  }

  // コマンドに一致しない自由文はClaude(AI)が処理する
  if (env.ANTHROPIC_API_KEY) {
    try {
      const accessToken = await getAccessTokenOrNull(env);
      return await handleWithAi(env.ANTHROPIC_API_KEY, {
        db: env.DB,
        userId,
        googleAccessToken: accessToken,
        buildTodayDigest,
      }, trimmed);
    } catch (e) {
      return `AI応答でエラーが発生しました: ${(e as Error).message}`;
    }
  }

  return `コマンドを認識できませんでした。\n\n${HELP_TEXT}`;
}

async function runReminderCheck(env: Env): Promise<void> {
  const now = new Date();
  const due = await getDueReminders(env.DB, now.toISOString());
  for (const reminder of due) {
    await pushText(
      env.LINE_CHANNEL_ACCESS_TOKEN,
      reminder.user_id,
      `⏰ リマインダー: ${reminder.content}`
    );
    await markNotified(env.DB, reminder.id);
  }
}

function getDigestTimes(env: Env): string[] {
  const raw = env.DAILY_DIGEST_TIME_JST;
  if (!raw) return DEFAULT_DIGEST_TIMES;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runDailyDigestIfDue(env: Env): Promise<void> {
  const now = new Date();
  const nowHm = currentJstHm(now);
  if (!getDigestTimes(env).includes(nowHm)) return;

  const target = await getPushTargetUserId(env);
  if (!target) return; // 送信先が未登録(誰もメッセージを送っていない)なら何もしない

  // 「日付+時刻」単位で送信済みかを記録し、同じ時刻枠での二重送信(cron再試行等)を防ぐ
  const sentKey = `${jstDateKey(now)} ${nowHm}`;
  const lastSentKey = await getAppState(env.DB, "last_digest_sent_at");
  if (lastSentKey === sentKey) return;

  const accessToken = await getAccessTokenOrNull(env);
  if (!accessToken) return; // 未連携ならダイジェストは送らない

  try {
    const digest = await buildTodayDigest(accessToken);
    await pushText(env.LINE_CHANNEL_ACCESS_TOKEN, target, digest);
    await setAppState(env.DB, "last_digest_sent_at", sentKey);
  } catch {
    // 取得失敗時は次の分に自然に再試行される(state未更新のため)
  }
}

// 翌日の予定を前日夜(既定21:00 JST)にまとめてLINE予告する。予定が無い日は送らない。
async function runTomorrowPreviewIfDue(env: Env): Promise<void> {
  const now = new Date();
  if (currentJstHm(now) !== TOMORROW_PREVIEW_TIME_JST) return;

  const target = await getPushTargetUserId(env);
  if (!target) return;

  const todayKey = jstDateKey(now);
  const lastKey = await getAppState(env.DB, "last_tomorrow_preview_date");
  if (lastKey === todayKey) return;

  const accessToken = await getAccessTokenOrNull(env);
  if (!accessToken) return;

  try {
    const { startUtcIso, endUtcIso } = jstTomorrowRangeUtc(now);
    const events = await listTodayEvents(accessToken, startUtcIso, endUtcIso);
    if (events.length > 0) {
      const lines = ["🌙 明日の予定"];
      for (const ev of events) {
        const time = ev.isAllDay ? "終日" : formatJstDateTime(ev.startIso).split(" ")[1];
        lines.push(`・${time} ${ev.summary}`);
      }
      await pushText(env.LINE_CHANNEL_ACCESS_TOKEN, target, lines.join("\n"));
    }
    // 予定が無くても「送信済み」として記録し、翌日まで再実行しない
    await setAppState(env.DB, "last_tomorrow_preview_date", todayKey);
  } catch {
    // 失敗時はstate未更新のまま次の分に再試行される
  }
}

// カレンダーの「【企業提案】〜様」の予定を検出し、当日締めの
// 「【企業調べ】〜様」ToDoをGoogle Tasksに自動作成する。毎朝 07:30 (JST) に実行。
async function runProposalPrepIfDue(env: Env): Promise<void> {
  const now = new Date();
  if (currentJstHm(now) !== PROPOSAL_PREP_TIME_JST) return;

  const todayKey = jstDateKey(now);
  const lastKey = await getAppState(env.DB, "last_proposal_prep_date");
  if (lastKey === todayKey) return; // その日は処理済み

  const accessToken = await getAccessTokenOrNull(env);
  if (!accessToken) return; // 未連携なら何もしない

  try {
    const { startUtcIso, endUtcIso } = jstTodayRangeUtc(now);
    const events = await listTodayEvents(accessToken, startUtcIso, endUtcIso);
    const proposals = events.filter((ev) => ev.summary.includes(PROPOSAL_MARKER));

    if (proposals.length === 0) {
      await setAppState(env.DB, "last_proposal_prep_date", todayKey);
      return;
    }

    // 既存の未完了ToDoと重複しないようにする
    const existing = await listIncompleteTasks(accessToken);
    const existingTitles = new Set(existing.map((t) => t.title));
    const dueToday = jstDateOnlyUtc(now.toISOString());

    for (const ev of proposals) {
      const title = ev.summary.replace(PROPOSAL_MARKER, RESEARCH_MARKER).trim();
      if (existingTitles.has(title)) continue;
      await insertTask(accessToken, title, dueToday);
      existingTitles.add(title);
    }

    await setAppState(env.DB, "last_proposal_prep_date", todayKey);
  } catch {
    // 失敗時はstate未更新のまま次の分に再試行される(作成済み分は重複チェックで回避)
  }
}

// 翌日のカレンダーの「【面接対策】〜様」を検出し、当日(=面接の前日)締めの
// 「面接対策準備〜様」ToDoをGoogle Tasksに自動作成する。毎朝 07:30 (JST) に実行。
async function runInterviewPrepIfDue(env: Env): Promise<void> {
  const now = new Date();
  if (currentJstHm(now) !== INTERVIEW_PREP_TIME_JST) return;

  const todayKey = jstDateKey(now);
  const lastKey = await getAppState(env.DB, "last_interview_prep_date");
  if (lastKey === todayKey) return; // その日は処理済み

  const accessToken = await getAccessTokenOrNull(env);
  if (!accessToken) return; // 未連携なら何もしない

  try {
    const { startUtcIso, endUtcIso } = jstTomorrowRangeUtc(now);
    const events = await listTodayEvents(accessToken, startUtcIso, endUtcIso);
    const interviews = events.filter((ev) => ev.summary.includes(INTERVIEW_MARKER));

    if (interviews.length === 0) {
      await setAppState(env.DB, "last_interview_prep_date", todayKey);
      return;
    }

    // 既存の未完了ToDoと重複しないようにする
    const existing = await listIncompleteTasks(accessToken);
    const existingTitles = new Set(existing.map((t) => t.title));
    const dueToday = jstDateOnlyUtc(now.toISOString()); // 面接の前日(=今日)が締切

    for (const ev of interviews) {
      const title = ev.summary.replace(INTERVIEW_MARKER, INTERVIEW_PREFIX).trim();
      if (existingTitles.has(title)) continue;
      await insertTask(accessToken, title, dueToday);
      existingTitles.add(title);
    }

    await setAppState(env.DB, "last_interview_prep_date", todayKey);
  } catch {
    // 失敗時はstate未更新のまま次の分に再試行される(作成済み分は重複チェックで回避)
  }
}

// circus/Threadsの必須設定が揃っているか確認する。
// circus側は「ログイン情報(URL+メール+パスワード)」または「静的トークン」のどちらかが必要。
function getThreadsConfig(env: Env): {
  circusUrl: string;
  circusLogin?: { loginUrl: string; email: string; password: string };
  circusToken?: string;
  threadsUserId: string;
  threadsToken: string;
} | null {
  const { CIRCUS_JOBS_URL, THREADS_USER_ID, THREADS_ACCESS_TOKEN } = env;
  if (!CIRCUS_JOBS_URL || !THREADS_USER_ID || !THREADS_ACCESS_TOKEN) return null;

  const hasLogin = !!(env.CIRCUS_LOGIN_URL && env.CIRCUS_EMAIL && env.CIRCUS_PASSWORD);
  // ログイン情報も静的トークンも無ければ求人を取得できない
  if (!hasLogin && !env.CIRCUS_API_TOKEN) return null;

  return {
    circusUrl: CIRCUS_JOBS_URL,
    circusLogin: hasLogin
      ? { loginUrl: env.CIRCUS_LOGIN_URL!, email: env.CIRCUS_EMAIL!, password: env.CIRCUS_PASSWORD! }
      : undefined,
    circusToken: env.CIRCUS_API_TOKEN,
    threadsUserId: THREADS_USER_ID,
    threadsToken: THREADS_ACCESS_TOKEN,
  };
}

interface ThreadsPostResult {
  posted: CircusJob[];
  skipped: number; // 投稿済みで今回スキップした件数
  fetched: number;
  error?: string;
}

// circusから求人を取得し、未投稿のものを最大maxPosts件だけThreadsへ投稿する。
// 投稿した求人はD1に記録して二度と投稿しないようにする。
async function postNewCircusJobsToThreads(env: Env, maxPosts: number): Promise<ThreadsPostResult> {
  const config = getThreadsConfig(env);
  if (!config) {
    return { posted: [], skipped: 0, fetched: 0, error: "circus/Threadsの設定(URL・トークン)が未設定です。" };
  }

  let jobs: CircusJob[];
  try {
    // ログイン情報があれば先にログインしてセッションを得る。無ければ静的トークンを使う。
    const auth = config.circusLogin
      ? await circusLogin(config.circusLogin.loginUrl, config.circusLogin.email, config.circusLogin.password)
      : { bearer: config.circusToken };
    jobs = await fetchCircusJobs(config.circusUrl, auth);
  } catch (e) {
    return { posted: [], skipped: 0, fetched: 0, error: `求人取得に失敗: ${(e as Error).message}` };
  }

  const posted: CircusJob[] = [];
  let skipped = 0;
  for (const job of jobs) {
    if (posted.length >= maxPosts) break;
    if (await isJobPosted(env.DB, job.key)) {
      skipped++;
      continue;
    }
    try {
      const mediaId = await postThreadsText(
        { userId: config.threadsUserId, accessToken: config.threadsToken },
        formatCircusJobPost(job)
      );
      await markJobPosted(env.DB, job.key, job.title, mediaId);
      posted.push(job);
    } catch (e) {
      // 投稿に失敗した求人は記録しない(次回再試行される)。1件失敗しても他は続行する。
      return {
        posted,
        skipped,
        fetched: jobs.length,
        error: `「${job.title}」の投稿に失敗: ${(e as Error).message}`,
      };
    }
  }

  return { posted, skipped, fetched: jobs.length };
}

function getThreadsMaxPosts(env: Env): number {
  const raw = Number(env.THREADS_MAX_POSTS_PER_RUN);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_THREADS_MAX_POSTS;
  return Math.floor(raw);
}

function getThreadsAutopostTimes(env: Env): string[] {
  const raw = env.THREADS_AUTOPOST_TIME_JST;
  if (!raw) return DEFAULT_THREADS_AUTOPOST_TIMES;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// circusの新着求人をThreadsへ自動投稿する。既定は9:00/15:00/21:00 (JST) の1日3回実行。
async function runThreadsAutoPostIfDue(env: Env): Promise<void> {
  const now = new Date();
  const nowHm = currentJstHm(now);
  if (!getThreadsAutopostTimes(env).includes(nowHm)) return;
  if (!getThreadsConfig(env)) return; // 未設定なら何もしない

  // 「日付+時刻」単位で送信済みを記録し、同じ時刻枠での二重投稿(cron再試行等)を防ぐ。
  const slotKey = `${jstDateKey(now)} ${nowHm}`;
  const lastKey = await getAppState(env.DB, "last_threads_autopost_slot");
  if (lastKey === slotKey) return; // その時刻枠は処理済み

  const result = await postNewCircusJobsToThreads(env, getThreadsMaxPosts(env));
  if (result.error && result.posted.length === 0) {
    // 取得/投稿が完全に失敗したときはstateを更新せず、次の分に再試行させる。
    return;
  }
  await setAppState(env.DB, "last_threads_autopost_slot", slotKey);

  // 投稿結果をオーナーにLINEで通知する(送信先が登録済みのときのみ)。
  const target = await getPushTargetUserId(env);
  if (target && result.posted.length > 0) {
    const lines = ["🧵 Threadsに新着求人を投稿しました"];
    for (const job of result.posted) {
      lines.push(`・${job.title}${job.company ? ` (${job.company})` : ""}`);
    }
    await pushText(env.LINE_CHANNEL_ACCESS_TOKEN, target, lines.join("\n"));
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runReminderCheck(env));
    ctx.waitUntil(runDailyDigestIfDue(env));
    ctx.waitUntil(runProposalPrepIfDue(env));
    ctx.waitUntil(runInterviewPrepIfDue(env));
    ctx.waitUntil(runTomorrowPreviewIfDue(env));
    ctx.waitUntil(runThreadsAutoPostIfDue(env));
  },
};
