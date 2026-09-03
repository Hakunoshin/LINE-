import { Hono } from "hono";
import { verifyLineSignature, replyText, pushText, replyFlex, type LineWebhookBody } from "./line";
import {
  addReminder,
  listPendingReminders,
  deleteReminder,
  getDueReminders,
  markNotified,
  getAppState,
  setAppState,
} from "./db";
import { parseReminderInput, formatJstDateTime, currentJstHm, jstDateKey, jstTodayRangeUtc, jstTomorrowRangeUtc, jstDateOnlyUtc } from "./dateParser";
import {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  getValidAccessToken,
  listTodayEvents,
  listIncompleteTasks,
  insertTask,
  completeTask,
} from "./google";
import { handleWithAi } from "./ai";
import { getTodayWeather } from "./weather";
import { getThreadsToken, recordThreadsPost, getRecentThreadsPosts } from "./db";
import { getValidThreadsToken, resolveThreadsUserId, publishThreadsText } from "./threads";
import { generateThreadsPost } from "./threadsContent";

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
  // 朝の配信に付ける天気の地点(未設定なら東京)
  WEATHER_LATITUDE?: string;
  WEATHER_LONGITUDE?: string;
  WEATHER_LOCATION_NAME?: string;
  // Threads(スレッズ)自動投稿。長期アクセストークンはsecretで設定する。
  THREADS_ACCESS_TOKEN?: string;
  // ThreadsユーザーID(任意)。未設定なら /me から自動解決する。
  THREADS_USER_ID?: string;
  // 自動投稿するJST時刻("HH:MM"のカンマ区切り)。未設定なら DEFAULT_THREADS_POST_TIMES。
  THREADS_POST_TIMES_JST?: string;
  // "off" にすると自動投稿を停止する(既定はon。ただしトークン未設定なら投稿しない)。
  THREADS_AUTO_POST?: string;
}

const DEFAULT_DIGEST_TIMES = ["07:30", "13:00", "18:00"];
const DEFAULT_THREADS_POST_TIMES = ["08:00", "12:30", "19:00"];
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

const HELP_TEXT = [
  "使えるコマンド:",
  "・追加 <日時> <内容>  例) 追加 明日9:00 ゴミ出し",
  "  日時は「今日/明日/明後日」「HH:MM」「YYYY-MM-DD」「M/D」などが使えます",
  "  Google連携済みならGoogle Tasksにも追加されます",
  "・一覧  … 未通知のリマインダーを表示",
  "・削除 <ID>  … リマインダーを削除",
  "・今日 / 【タスク】  … 今日の予定とGoogle Tasksの未完了ToDoを表示",
  "・完了  … 未完了ToDoをボタン付きで表示し、押すと完了にできます",
  "・Threads下書き  … 自動投稿と同じAIでThreadsの下書きだけ作成(投稿しない)",
  "・Threads投稿  … 下書きをその場で生成してThreadsへ即時投稿",
  "・Threads状態  … 自動投稿の設定状況を表示",
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
    const userId = event.source.userId;
    if (!userId || !event.replyToken) continue;

    if (c.env.ALLOWED_USER_ID && userId !== c.env.ALLOWED_USER_ID) {
      // 本人以外からのメッセージには応答しない
      continue;
    }

    // 自動配信(push)の送信先として、メッセージ送信者のuserIdを記録しておく。
    // ALLOWED_USER_IDが未設定でも、一度でもメッセージを送れば自動配信が有効になる。
    await setAppState(c.env.DB, "owner_user_id", userId);

    // ToDoの「完了」ボタン(ポストバック)を処理する
    if (event.type === "postback" && event.postback) {
      const reply = await handlePostback(c.env, event.postback.data);
      await replyText(c.env.LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, reply);
      continue;
    }

    if (event.type !== "message" || event.message?.type !== "text") {
      continue;
    }

    const text = event.message.text ?? "";
    const baseUrl = new URL(c.req.url).origin;
    const reply = await handleCommand(c.env, userId, text, baseUrl);
    if (typeof reply === "string") {
      await replyText(c.env.LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, reply);
    } else {
      await replyFlex(c.env.LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, reply.altText, reply.contents);
    }
  }

  return c.text("ok");
});

// ToDo完了ボタンのポストバック(data="done:<taskId>")を処理する
async function handlePostback(env: Env, data: string): Promise<string> {
  if (data.startsWith("done:")) {
    const taskId = data.slice("done:".length);
    const accessToken = await getAccessTokenOrNull(env);
    if (!accessToken) return "Googleと連携されていないため完了できませんでした。";
    try {
      const title = await completeTask(accessToken, taskId);
      return `✅ 完了しました: ${title}`;
    } catch (e) {
      return `完了処理に失敗しました: ${(e as Error).message}`;
    }
  }
  return "不明な操作です。";
}

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

// コマンドの応答はテキストか、ボタン付きFlexメッセージのどちらか
type CommandReply = string | { altText: string; contents: unknown };

// 未完了ToDoを「完了」ボタン付きのFlexメッセージに組み立てる
const FLEX_TASK_LIMIT = 20;
function buildTaskListFlex(tasks: { id: string; title: string }[]): { altText: string; contents: unknown } {
  const shown = tasks.slice(0, FLEX_TASK_LIMIT);
  const rows: unknown[] = [];
  for (const t of shown) {
    rows.push({
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      margin: "md",
      alignItems: "center",
      contents: [
        { type: "text", text: t.title, wrap: true, size: "sm", flex: 5, gravity: "center" },
        {
          type: "button",
          style: "primary",
          color: "#22aa66",
          height: "sm",
          flex: 3,
          action: {
            type: "postback",
            label: "完了",
            data: `done:${t.id}`,
            displayText: `完了: ${t.title}`,
          },
        },
      ],
    });
  }
  if (tasks.length > FLEX_TASK_LIMIT) {
    rows.push({ type: "text", text: `ほか${tasks.length - FLEX_TASK_LIMIT}件`, size: "xs", color: "#999999", margin: "md" });
  }

  const contents = {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: "未完了のToDo", weight: "bold", size: "lg" },
        { type: "separator", margin: "md" },
        ...rows,
      ],
    },
  };
  return { altText: "未完了のToDo一覧", contents };
}

async function handleCommand(env: Env, userId: string, text: string, baseUrl: string): Promise<CommandReply> {
  const trimmed = text.trim();

  if (trimmed === "ヘルプ" || trimmed === "help") {
    return HELP_TEXT;
  }

  if (trimmed === "完了" || trimmed === "todo" || trimmed === "ToDo") {
    const accessToken = await getAccessTokenOrNull(env);
    if (!accessToken) {
      return `Googleと連携されていません。\n${baseUrl}/oauth/start から連携してください。`;
    }
    try {
      const tasks = await listIncompleteTasks(accessToken);
      if (tasks.length === 0) return "未完了のToDoはありません。";
      return buildTaskListFlex(tasks);
    } catch (e) {
      return `ToDoの取得に失敗しました: ${(e as Error).message}`;
    }
  }

  if (trimmed === "Threads下書き" || trimmed === "スレッズ下書き" || trimmed === "threads下書き") {
    if (!env.ANTHROPIC_API_KEY) {
      return "ANTHROPIC_API_KEY が未設定のため下書きを生成できません。";
    }
    try {
      const recent = await getRecentThreadsPosts(env.DB, 10);
      const text = await generateThreadsPost(env.ANTHROPIC_API_KEY, recent);
      return `📝 Threads下書き(投稿はしていません)\n──────────\n${text}\n──────────\nこのまま投稿するなら「Threads投稿」と送ってください。`;
    } catch (e) {
      return `下書きの生成に失敗しました: ${(e as Error).message}`;
    }
  }

  if (trimmed === "Threads投稿" || trimmed === "スレッズ投稿" || trimmed === "threads投稿") {
    try {
      const { text, id } = await postToThreadsNow(env);
      return `🧵 Threadsに投稿しました (id: ${id})\n──────────\n${text}`;
    } catch (e) {
      return `Threadsへの投稿に失敗しました: ${(e as Error).message}`;
    }
  }

  if (trimmed === "Threads状態" || trimmed === "スレッズ状態" || trimmed === "threads状態") {
    return await buildThreadsStatus(env);
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
      let digest = await buildTodayDigest(accessToken);
      const weather = await getTodayWeatherLine(env);
      if (weather) digest = `${weather}\n\n${digest}`;
      await pushText(env.LINE_CHANNEL_ACCESS_TOKEN, userId, digest);
      return "テスト配信をプッシュ送信しました。この直後に届く別メッセージが朝の自動配信と同じ形式です。";
    } catch (e) {
      return `テスト配信に失敗しました: ${(e as Error).message}`;
    }
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
    let digest = await buildTodayDigest(accessToken);
    // 朝(07:30)の配信にだけ今日の天気を付ける
    if (nowHm === PROPOSAL_PREP_TIME_JST) {
      const weather = await getTodayWeatherLine(env);
      if (weather) digest = `${weather}\n\n${digest}`;
    }
    await pushText(env.LINE_CHANNEL_ACCESS_TOKEN, target, digest);
    await setAppState(env.DB, "last_digest_sent_at", sentKey);
  } catch {
    // 取得失敗時は次の分に自然に再試行される(state未更新のため)
  }
}

// 環境変数から天気地点を解決して今日の天気を1行取得(既定は東京)
async function getTodayWeatherLine(env: Env): Promise<string | null> {
  const latitude = Number(env.WEATHER_LATITUDE ?? "35.6895");
  const longitude = Number(env.WEATHER_LONGITUDE ?? "139.6917");
  const locationName = env.WEATHER_LOCATION_NAME ?? "東京";
  try {
    const line = await getTodayWeather({ latitude, longitude, locationName });
    return line ? `🌦️ 今日の天気 ${line}` : null;
  } catch {
    return null;
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

// ===== Threads(スレッズ)自動投稿 =====

function getThreadsPostTimes(env: Env): string[] {
  const raw = env.THREADS_POST_TIMES_JST;
  if (!raw) return DEFAULT_THREADS_POST_TIMES;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// トークンが(secretかD1のいずれかで)利用可能かどうか
async function hasThreadsToken(env: Env): Promise<boolean> {
  if (env.THREADS_ACCESS_TOKEN) return true;
  return (await getThreadsToken(env.DB)) !== null;
}

// 下書きを生成(未指定時)してThreadsへ投稿し、投稿履歴に記録する。
async function postToThreadsNow(env: Env, presetText?: string): Promise<{ text: string; id: string }> {
  const token = await getValidThreadsToken(env.DB, env.THREADS_ACCESS_TOKEN);
  if (!token) {
    throw new Error("Threadsアクセストークンが未設定です。`wrangler secret put THREADS_ACCESS_TOKEN` で設定してください。");
  }
  const userId = env.THREADS_USER_ID || (await resolveThreadsUserId(env.DB, token));

  let text = presetText;
  if (!text) {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY が未設定のため本文を生成できません。");
    }
    const recent = await getRecentThreadsPosts(env.DB, 10);
    text = await generateThreadsPost(env.ANTHROPIC_API_KEY, recent);
  }

  const id = await publishThreadsText(token, userId, text);
  await recordThreadsPost(env.DB, text, id);
  return { text, id };
}

async function buildThreadsStatus(env: Env): Promise<string> {
  const tokenReady = await hasThreadsToken(env);
  const autoOff = (env.THREADS_AUTO_POST ?? "").toLowerCase() === "off";
  const times = getThreadsPostTimes(env).join(" / ");
  const lastPost = await getAppState(env.DB, "last_threads_post_at");
  const recent = await getRecentThreadsPosts(env.DB, 1);

  const lines = [
    "🧵 Threads自動投稿の状態",
    "",
    `・アクセストークン: ${tokenReady ? "設定済み ✅" : "未設定 ❌ (secretで設定が必要)"}`,
    `・自動投稿: ${autoOff ? "停止中(THREADS_AUTO_POST=off)" : tokenReady ? "有効 ✅" : "待機中(トークン未設定)"}`,
    `・投稿時刻(JST): ${times}`,
    `・直近の自動投稿枠: ${lastPost ?? "なし"}`,
  ];
  if (recent.length > 0) {
    lines.push("", "直近の投稿:", recent[0]);
  }
  if (!tokenReady) {
    lines.push("", "セットアップ手順はREADMEの「Threads自動投稿」を参照してください。");
  }
  return lines.join("\n");
}

// 設定した時刻(JST)に、求人・自社PR系の投稿を自動生成してThreadsへ公開する。
// 同一時刻枠での二重投稿を防ぐため、投稿前にstateで枠を確保する(外部への投稿は取り消せないため)。
async function runThreadsAutoPostIfDue(env: Env): Promise<void> {
  if ((env.THREADS_AUTO_POST ?? "").toLowerCase() === "off") return;

  const now = new Date();
  const nowHm = currentJstHm(now);
  if (!getThreadsPostTimes(env).includes(nowHm)) return;

  if (!(await hasThreadsToken(env))) return; // トークン未設定なら何もしない

  const slotKey = `${jstDateKey(now)} ${nowHm}`;
  const lastSlot = await getAppState(env.DB, "last_threads_post_at");
  if (lastSlot === slotKey) return;

  // 投稿前に枠を確保 → 生成/公開が失敗しても同じ枠で再投稿(二重投稿)しない
  await setAppState(env.DB, "last_threads_post_at", slotKey);

  const target = await getPushTargetUserId(env);
  try {
    const { text } = await postToThreadsNow(env);
    if (target) {
      await pushText(env.LINE_CHANNEL_ACCESS_TOKEN, target, `🧵 Threadsに自動投稿しました:\n\n${text}`);
    }
  } catch (e) {
    if (target) {
      await pushText(
        env.LINE_CHANNEL_ACCESS_TOKEN,
        target,
        `⚠️ Threads自動投稿に失敗しました(${nowHm}枠): ${(e as Error).message}`
      );
    }
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
