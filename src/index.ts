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
  insertPostMetric,
  updatePostMetric,
  listRecentPostMetrics,
  listTopPostMetrics,
  getCtaStats,
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
import {
  postThreadsText,
  buildThreadsAuthUrl,
  completeThreadsOAuth,
  getValidThreadsConfig,
  getThreadsInsights,
  type ThreadsConfig,
} from "./threads";
import { generateThreadsPostFromText, buildTemplatePost, analyzePerformance, type CtaType } from "./threadsContent";
import { fetchCircusPublicJob, extractCircusJobUrls, circusJobToText, type CircusJob } from "./circus";
import { DEFAULT_JOB_URLS } from "./jobs";

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
  // --- 求人(circus公開URL) → Threads自動投稿 ---
  // 投稿対象の求人URLを載せた外部ページのURL(任意)。設定するとそのページ本文から
  // circusの公開URLを自動抽出して使う。未設定なら src/jobs.ts の DEFAULT_JOB_URLS を使う。
  JOBS_PAGE_URL?: string;
  // Threads OAuthアプリ。設定すると /threads/start で連携でき、トークンを自動refreshする。
  THREADS_APP_ID?: string;
  THREADS_APP_SECRET?: string;
  // (任意) 手動発行した長期トークンを直接使う場合。OAuth連携を使うなら不要。
  THREADS_USER_ID?: string;
  THREADS_ACCESS_TOKEN?: string;
  // 自動投稿を実行するJSTの時刻 ("HH:MM"のカンマ区切り)。未設定なら DEFAULT_THREADS_AUTOPOST_TIMES。
  THREADS_AUTOPOST_TIME_JST?: string;
  // 投稿指標の収集と分析を行うJSTの時刻。未設定なら DEFAULT_THREADS_INSIGHTS_TIME。
  THREADS_INSIGHTS_TIME_JST?: string;
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

// 求人(circus公開URL) → Threads自動投稿。既定は9:00/15:00/21:00 JSTの1日3回、各回ランダムに1件。
const DEFAULT_THREADS_AUTOPOST_TIMES = ["08:00", "13:00", "17:00", "21:00"];
// 投稿指標の収集+分析を回す時刻(1日1回)。
const DEFAULT_THREADS_INSIGHTS_TIME = "23:30";
const THREADS_POST_COMMAND = "求人投稿";

// 「投稿テスト」コマンドで送る秘書通知のサンプル本文(実投稿はしない)。
const SAMPLE_POST_TEXT = [
  "未経験から挑戦できる営業職👀",
  "",
  "💰 想定年収 400〜1000万円",
  "🗓 年間休日128日",
  "🔰 未経験歓迎",
  "",
  "気になる方はお気軽にDMください📩",
  "",
  "#求人 #転職 #未経験歓迎",
].join("\n");

// CTA(DM誘導/コメント誘導)のA/Bテスト設定。
const CTA_TYPES: CtaType[] = ["dm", "comment"];
// 各CTAがこの件数(指標付き)に達するまではランダムに出して探索する。
const CTA_MIN_SAMPLES = 3;
// 探索率: この確率で勝ってる方でなくランダムに選ぶ(ε-greedy)。
const CTA_EPSILON = 0.25;

const HELP_TEXT = [
  "使えるコマンド:",
  "・追加 <日時> <内容>  例) 追加 明日9:00 ゴミ出し",
  "  日時は「今日/明日/明後日」「HH:MM」「YYYY-MM-DD」「M/D」などが使えます",
  "  Google連携済みならGoogle Tasksにも追加されます",
  "・一覧  … 未通知のリマインダーを表示",
  "・削除 <ID>  … リマインダーを削除",
  "・今日 / 【タスク】  … 今日の予定とGoogle Tasksの未完了ToDoを表示",
  "・求人投稿  … 求人リストからランダムに1件を今すぐThreadsへ投稿",
  "・投稿テスト  … 「投稿した体」の秘書通知だけを送る(Threadsには投稿しない)",
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

// Threads連携: /threads/start にアクセス → 認可 → /threads/callback で長期トークンをD1に保存。
app.get("/threads/start", (c) => {
  const { THREADS_APP_ID } = c.env;
  if (!THREADS_APP_ID) {
    return c.text("THREADS_APP_ID が設定されていません。", 500);
  }
  const redirectUri = new URL("/threads/callback", c.req.url).toString();
  return c.redirect(buildThreadsAuthUrl(THREADS_APP_ID, redirectUri));
});

app.get("/threads/callback", async (c) => {
  const { THREADS_APP_ID, THREADS_APP_SECRET } = c.env;
  if (!THREADS_APP_ID || !THREADS_APP_SECRET) {
    return c.text("THREADS_APP_ID / THREADS_APP_SECRET が設定されていません。", 500);
  }
  const error = c.req.query("error");
  if (error) {
    return c.text(`Threads認証がキャンセルまたは失敗しました: ${error}`, 400);
  }
  // Threadsはcodeの末尾に "#_" を付けることがあるので除去する。
  const code = (c.req.query("code") ?? "").replace(/#_$/, "");
  if (!code) {
    return c.text("codeパラメータがありません。", 400);
  }
  const redirectUri = new URL("/threads/callback", c.req.url).toString();
  try {
    await completeThreadsOAuth(THREADS_APP_ID, THREADS_APP_SECRET, redirectUri, code, c.env.DB);
  } catch (e) {
    return c.text(`Threads連携に失敗しました: ${(e as Error).message}`, 500);
  }
  return c.text("Threads連携が完了しました。このタブは閉じて大丈夫です。");
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
    // 1イベントの処理でエラーが出ても無言で落とさず、エラー内容を返信する。
    try {
      const reply = await handleCommand(c.env, userId, text, baseUrl);
      await replyText(c.env.LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, reply);
    } catch (e) {
      // 原因調査用にエラーをD1へ記録しておく。
      try {
        await setAppState(c.env.DB, "last_webhook_error", `${text}: ${(e as Error).message}`);
      } catch {
        // 記録失敗は無視
      }
      try {
        await replyText(
          c.env.LINE_CHANNEL_ACCESS_TOKEN,
          event.replyToken,
          `エラーが発生しました: ${(e as Error).message}`
        );
      } catch {
        // 返信自体が失敗した場合は諦める(cronの再試行等には影響しない)
      }
    }
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

  if (trimmed === "投稿テスト" || trimmed === "通知テスト" || trimmed === "Threadsテスト") {
    // 実際にはThreadsへ投稿せず、「投稿した体」の秘書通知だけを本番と同じ形式で送る。
    await notifyOwnerOfPost(env, SAMPLE_POST_TEXT, "dm");
    return "秘書からの投稿通知をテスト送信しました。この直後に届くメッセージが、実際の自動投稿時と同じ形式です(Threadsへの投稿はしていません)。";
  }

  if (trimmed === THREADS_POST_COMMAND || trimmed === "Threads投稿") {
    if (!isThreadsConfigured(env)) {
      return `Threadsが未連携です。${baseUrl}/threads/start から連携してください。`;
    }
    const result = await postRandomJobToThreads(env);
    if (result.postedText) {
      const cta = result.cta ? ` (導線: ${ctaLabel(result.cta)})` : "";
      return `Threadsに投稿しました。${cta}\n\n${result.postedText}`;
    }
    return `投稿できませんでした: ${result.error ?? "不明なエラー"}`;
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

// Threadsの投稿先が設定されているか(静的トークン or OAuthアプリのどちらか)。
function isThreadsConfigured(env: Env): boolean {
  const hasStatic = !!(env.THREADS_USER_ID && env.THREADS_ACCESS_TOKEN);
  const hasApp = !!(env.THREADS_APP_ID && env.THREADS_APP_SECRET);
  return hasStatic || hasApp;
}

// 投稿に使う有効なThreads認証情報を返す。静的トークン優先、無ければD1(自動refresh)。
async function resolveThreadsConfig(env: Env): Promise<ThreadsConfig | null> {
  if (env.THREADS_USER_ID && env.THREADS_ACCESS_TOKEN) {
    return { userId: env.THREADS_USER_ID, accessToken: env.THREADS_ACCESS_TOKEN };
  }
  return await getValidThreadsConfig(env.DB);
}

interface PostResult {
  postedText?: string;
  cta?: CtaType;
  error?: string;
}

function randomCta(): CtaType {
  return CTA_TYPES[Math.floor(Math.random() * CTA_TYPES.length)];
}

// どちらのCTAを使うかをε-greedyで決める。
// 各CTAが十分なサンプルを持つまではランダム(探索)、揃ったら平均エンゲージメントが高い方を
// 確率(1-ε)で採用し、εの確率では引き続きランダムに探索する。
async function chooseCta(env: Env): Promise<CtaType> {
  const stats = await getCtaStats(env.DB);
  const byType = new Map(stats.map((s) => [s.cta_type, s]));
  const enough = CTA_TYPES.every((t) => (byType.get(t)?.n ?? 0) >= CTA_MIN_SAMPLES);
  if (!enough || Math.random() < CTA_EPSILON) {
    return randomCta();
  }
  // 平均エンゲージメントが高い方を採用。
  let best: CtaType = CTA_TYPES[0];
  let bestAvg = -1;
  for (const t of CTA_TYPES) {
    const avg = byType.get(t)?.avg_engagement ?? 0;
    if (avg > bestAvg) {
      bestAvg = avg;
      best = t;
    }
  }
  return best;
}

// 投稿対象の求人URL一覧を返す。JOBS_PAGE_URLがあればそのページから抽出、無ければ既定リスト。
async function getJobUrls(env: Env): Promise<string[]> {
  if (env.JOBS_PAGE_URL) {
    try {
      const res = await fetch(env.JOBS_PAGE_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.ok) {
        const urls = extractCircusJobUrls(await res.text());
        if (urls.length > 0) return urls;
      }
    } catch {
      // 取得失敗時は既定リストにフォールバック
    }
  }
  return DEFAULT_JOB_URLS;
}

// 求人URLリストからランダムに1件選び、circusから内容を取得して投稿文を生成、Threadsへ投稿する。
// 投稿文はClaudeが「これまで伸びた傾向(learnings)」を踏まえて生成し、
// 投稿本文は分析用にthreads_post_metricsへ記録する。
async function postRandomJobToThreads(env: Env): Promise<PostResult> {
  await setAppState(env.DB, "post_stage", "1_start");
  const threads = await resolveThreadsConfig(env);
  if (!threads) {
    return { error: "Threads未連携です。/threads/start から連携してください。" };
  }

  const urls = await getJobUrls(env);
  if (urls.length === 0) {
    return { error: "投稿できる求人URLがありません(src/jobs.ts または JOBS_PAGE_URL を設定してください)。" };
  }

  // 直前に投稿したURLは(他に候補があれば)避けて、連続同一投稿を防ぐ。
  const lastUrl = await getAppState(env.DB, "last_posted_job_url");
  const candidates = urls.length > 1 ? urls.filter((u) => u !== lastUrl) : urls;
  const url = candidates[Math.floor(Math.random() * candidates.length)];

  // circusの公開URLから求人内容を取得する。
  await setAppState(env.DB, "post_stage", "2_fetching");
  let job: CircusJob;
  try {
    job = await fetchCircusPublicJob(url);
  } catch (e) {
    await setAppState(env.DB, "post_stage", `error_fetch:${(e as Error).message}`.slice(0, 90));
    return { error: `求人取得に失敗: ${(e as Error).message}` };
  }
  const jobId = job.id || url;
  await setAppState(env.DB, "post_stage", "3_job_fetched");

  // A/Bテストで今回のCTA(DM誘導 or コメント誘導)を決める。
  const cta = await chooseCta(env);

  // 投稿文を生成。APIキーがあればClaudeが「伸びる型(learnings)」を反映して作文＋企業名を匿名化。
  // 無ければ構造化テンプレート(企業名は機械的に除去)で組み立てる。どちらも企業名は出さない。
  const learnings = await getAppState(env.DB, "threads_post_learnings");
  let text = buildTemplatePost(job, cta);
  if (env.ANTHROPIC_API_KEY) {
    try {
      text = await generateThreadsPostFromText(
        env.ANTHROPIC_API_KEY,
        circusJobToText(job),
        learnings,
        cta,
        job.company
      );
    } catch {
      text = buildTemplatePost(job, cta);
    }
  }

  await setAppState(env.DB, "post_stage", "4_posting");
  try {
    const mediaId = await postThreadsText(threads, text);
    await insertPostMetric(env.DB, mediaId, `circus:${jobId}`, text, cta);
    await setAppState(env.DB, "last_posted_job_url", url);
    await setAppState(env.DB, "post_stage", "5_done");
    return { postedText: text, cta };
  } catch (e) {
    await setAppState(env.DB, "post_stage", `error_posting:${(e as Error).message}`.slice(0, 80));
    return { error: `投稿に失敗: ${(e as Error).message}` };
  }
}

function getThreadsAutopostTimes(env: Env): string[] {
  const raw = env.THREADS_AUTOPOST_TIME_JST;
  if (!raw) return DEFAULT_THREADS_AUTOPOST_TIMES;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function ctaLabel(cta?: CtaType): string {
  if (cta === "dm") return "DM誘導";
  if (cta === "comment") return "コメント誘導";
  return "";
}

// 投稿結果を「秘書からの報告」としてLINEに通知する。投稿本文と今回の導線(CTA)も添える。
async function notifyOwnerOfPost(env: Env, text: string, cta?: CtaType): Promise<void> {
  const target = await getPushTargetUserId(env);
  if (!target) return;
  const header = cta
    ? `秘書です。以下の求人をThreadsに投稿しました🧵 (導線: ${ctaLabel(cta)})`
    : "秘書です。以下の求人をThreadsに投稿しました🧵";
  await pushText(env.LINE_CHANNEL_ACCESS_TOKEN, target, [header, "", text].join("\n"));
}

// 求人URLリストからランダムに1件Threadsへ自動投稿する。既定は9:00/15:00/21:00 (JST) の1日3回実行。
async function runThreadsAutoPostIfDue(env: Env): Promise<void> {
  const now = new Date();
  const nowHm = currentJstHm(now);
  if (!getThreadsAutopostTimes(env).includes(nowHm)) return;
  if (!isThreadsConfigured(env)) return; // 未連携なら何もしない

  // 「日付+時刻」単位で送信済みを記録し、同じ時刻枠での二重投稿(cron再試行等)を防ぐ。
  const slotKey = `${jstDateKey(now)} ${nowHm}`;
  const lastKey = await getAppState(env.DB, "last_threads_autopost_slot");
  if (lastKey === slotKey) return; // その時刻枠は処理済み

  const result = await postRandomJobToThreads(env);
  if (!result.postedText) {
    // 投稿に失敗したときはstateを更新せず、次の分に再試行させる。
    return;
  }
  await setAppState(env.DB, "last_threads_autopost_slot", slotKey);
  await notifyOwnerOfPost(env, result.postedText, result.cta);
}

function getThreadsInsightsTime(env: Env): string {
  return env.THREADS_INSIGHTS_TIME_JST || DEFAULT_THREADS_INSIGHTS_TIME;
}

// 直近14日の投稿のインサイトをThreadsから取得して更新し、
// その結果をClaudeで分析して「伸びる型」のメモを更新する。既定23:30 JSTに1日1回。
async function runThreadsInsightsIfDue(env: Env): Promise<void> {
  const now = new Date();
  if (currentJstHm(now) !== getThreadsInsightsTime(env)) return;
  if (!isThreadsConfigured(env)) return;

  const todayKey = jstDateKey(now);
  const lastKey = await getAppState(env.DB, "last_threads_insights_date");
  if (lastKey === todayKey) return;

  const threads = await resolveThreadsConfig(env);
  if (!threads) return;

  try {
    // (1) 直近14日の投稿の指標を更新する
    const since = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const recent = await listRecentPostMetrics(env.DB, since);
    for (const post of recent) {
      try {
        const insights = await getThreadsInsights(threads, post.media_id);
        await updatePostMetric(env.DB, post.media_id, insights);
      } catch {
        // 個別の取得失敗は無視して次へ(投稿直後で指標未確定など)
      }
    }

    // (2) 上位投稿をClaudeで分析し、「伸びる型」メモを更新する
    if (env.ANTHROPIC_API_KEY) {
      const top = await listTopPostMetrics(env.DB, 20);
      if (top.length >= 3) {
        const memo = await analyzePerformance(env.ANTHROPIC_API_KEY, top);
        if (memo) await setAppState(env.DB, "threads_post_learnings", memo);
      }
    }

    await setAppState(env.DB, "last_threads_insights_date", todayKey);
  } catch {
    // 全体失敗時はstate未更新のまま翌分に再試行される
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
    ctx.waitUntil(runThreadsInsightsIfDue(env));
  },
};
