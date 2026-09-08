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
import { generateArticle, postArticle } from "./note";

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
  // --- note自動投稿(任意) ---
  // ブラウザでnoteにログインして取得した _note_session_v5 Cookieの値。
  // 未設定ならnote関連機能はすべて無効。
  NOTE_SESSION_COOKIE?: string;
  // 自動投稿するJST時刻 ("HH:MM")。未設定なら定期自動投稿を行わない(手動コマンドは可)。
  NOTE_POST_TIME_JST?: string;
  // 自動投稿する曜日 (JST, 0=日〜6=土) のカンマ区切り。未設定なら毎日。
  NOTE_POST_DOW?: string;
  // 記事テーマの候補。改行または「|」区切り。日付でローテーションして1つ選ぶ。
  // 未設定ならキャリア系のデフォルトテーマを使用。
  NOTE_TOPICS?: string;
  // "true" のとき実際に公開する。それ以外(既定)は下書き保存のみ(安全側)。
  NOTE_AUTOPUBLISH?: string;
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

// note自動投稿でテーマ未設定時に使うデフォルトテーマ(キャリア/転職領域)
const DEFAULT_NOTE_TOPICS = [
  "転職活動で後悔しないための企業選びの軸の作り方",
  "職務経歴書で自分の強みを伝えるコツ",
  "面接で緊張しないための準備と当日の心構え",
  "初めての転職エージェント活用術",
  "キャリアの棚卸しで自分の市場価値を知る方法",
  "退職を決める前に考えておきたいこと",
  "未経験職種に挑戦するときのアピールの仕方",
];

const HELP_TEXT = [
  "使えるコマンド:",
  "・追加 <日時> <内容>  例) 追加 明日9:00 ゴミ出し",
  "  日時は「今日/明日/明後日」「HH:MM」「YYYY-MM-DD」「M/D」などが使えます",
  "  Google連携済みならGoogle Tasksにも追加されます",
  "・一覧  … 未通知のリマインダーを表示",
  "・削除 <ID>  … リマインダーを削除",
  "・今日 / 【タスク】  … 今日の予定とGoogle Tasksの未完了ToDoを表示",
  "・完了  … 未完了ToDoをボタン付きで表示し、押すと完了にできます",
  "・note下書き <テーマ>  … AIが記事を書いてnoteに下書き保存(テーマ省略可)",
  "・note投稿 <テーマ>  … AIが記事を書いてnoteに公開(テーマ省略可)",
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

  // note投稿(公開) / note下書き(下書き保存のみ)
  //   例) note下書き 転職の面接対策    /    note投稿 職務経歴書の書き方
  if (trimmed.startsWith("note投稿") || trimmed.startsWith("note下書き")) {
    const publish = trimmed.startsWith("note投稿");
    const theme = trimmed.replace(publish ? "note投稿" : "note下書き", "").trim();
    return await createNotePost(env, theme || pickNoteTopic(env), publish);
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

// テーマ候補を解決する。NOTE_TOPICS(改行/「|」区切り)優先、無ければデフォルト。
function getNoteTopics(env: Env): string[] {
  const raw = env.NOTE_TOPICS?.trim();
  if (!raw) return DEFAULT_NOTE_TOPICS;
  const list = raw
    .split(/\n|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_NOTE_TOPICS;
}

// 日付(JST)でテーマをローテーション選択する。毎日違うテーマが選ばれる。
function pickNoteTopic(env: Env, now: Date = new Date()): string {
  const topics = getNoteTopics(env);
  // JSTのエポック日数でインデックスを回す
  const jstDays = Math.floor((now.getTime() + 9 * 3600 * 1000) / 86400000);
  return topics[jstDays % topics.length];
}

// 記事を生成してnoteに投稿する共通処理。手動コマンドと自動投稿の両方から使う。
async function createNotePost(env: Env, theme: string, publish: boolean): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) {
    return "ANTHROPIC_API_KEY が未設定のため記事を生成できません。";
  }
  if (!env.NOTE_SESSION_COOKIE) {
    return "NOTE_SESSION_COOKIE が未設定です。noteにブラウザでログインし _note_session_v5 を取得して\nnpx wrangler secret put NOTE_SESSION_COOKIE\nで設定してください。";
  }
  try {
    const article = await generateArticle(env.ANTHROPIC_API_KEY, theme);
    const result = await postArticle(env.NOTE_SESSION_COOKIE, article, publish);
    return [
      `📝 note${result.status === "published" ? "に公開しました" : "に下書き保存しました"}`,
      `タイトル: ${article.title}`,
      `テーマ: ${theme}`,
      result.url ? `URL: ${result.url}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  } catch (e) {
    return `note投稿に失敗しました: ${(e as Error).message}`;
  }
}

// NOTE_POST_TIME_JST の時刻(と曜日)になったらnoteへ自動投稿する。
// 二重投稿は last_note_post_date(JST日付)で防ぐ。既定は下書き保存(NOTE_AUTOPUBLISH=trueで公開)。
async function runNoteAutoPostIfDue(env: Env): Promise<void> {
  const time = env.NOTE_POST_TIME_JST?.trim();
  if (!time) return; // 未設定なら定期自動投稿しない
  const now = new Date();
  if (currentJstHm(now) !== time) return;

  // 曜日フィルタ(JST)。未設定なら毎日。
  const dowRaw = env.NOTE_POST_DOW?.trim();
  if (dowRaw) {
    const jstDow = new Date(now.getTime() + 9 * 3600 * 1000).getUTCDay(); // 0=日
    const allowed = dowRaw.split(",").map((s) => Number(s.trim()));
    if (!allowed.includes(jstDow)) return;
  }

  const todayKey = jstDateKey(now);
  const lastKey = await getAppState(env.DB, "last_note_post_date");
  if (lastKey === todayKey) return; // その日は投稿済み

  if (!env.ANTHROPIC_API_KEY || !env.NOTE_SESSION_COOKIE) return;

  const publish = env.NOTE_AUTOPUBLISH === "true";
  const theme = pickNoteTopic(env, now);
  try {
    const article = await generateArticle(env.ANTHROPIC_API_KEY, theme);
    const result = await postArticle(env.NOTE_SESSION_COOKIE, article, publish);
    // 成功したら記録し、その日は再投稿しない
    await setAppState(env.DB, "last_note_post_date", todayKey);
    // 送信先が分かれば結果をLINEに通知する
    const target = await getPushTargetUserId(env);
    if (target) {
      const head = result.status === "published" ? "📝 noteに自動公開しました" : "📝 noteに下書きを自動作成しました";
      await pushText(
        env.LINE_CHANNEL_ACCESS_TOKEN,
        target,
        [head, `タイトル: ${article.title}`, result.url ? `URL: ${result.url}` : ""].filter(Boolean).join("\n")
      );
    }
  } catch (e) {
    // 失敗時はstate未更新のまま次の分に再試行される。通知先が分かればエラーを知らせる。
    const target = await getPushTargetUserId(env);
    if (target) {
      await pushText(env.LINE_CHANNEL_ACCESS_TOKEN, target, `note自動投稿に失敗しました: ${(e as Error).message}`);
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
    ctx.waitUntil(runNoteAutoPostIfDue(env));
  },
};
