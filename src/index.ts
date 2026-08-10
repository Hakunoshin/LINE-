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
  addThreadPost,
  listPendingThreadPosts,
  deleteThreadPost,
  getDueThreadPosts,
  markThreadPostPosted,
  markThreadPostFailed,
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
import { handleWithAi, generateThreadPost } from "./ai";
import { getTodayWeather } from "./weather";
import {
  buildThreadsAuthUrl,
  exchangeThreadsCode,
  getValidThreadsToken,
  publishTextPost,
  THREADS_TEXT_LIMIT,
} from "./threads";

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
  // Threads(Meta)連携。Meta for Developersで作成したThreadsアプリのID/Secret。
  // 設定すると「別アカウント」のThreadsへ予約投稿・自動投稿できるようになる。
  THREADS_APP_ID?: string;
  THREADS_APP_SECRET?: string;
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

const HELP_TEXT = [
  "使えるコマンド:",
  "・追加 <日時> <内容>  例) 追加 明日9:00 ゴミ出し",
  "  日時は「今日/明日/明後日」「HH:MM」「YYYY-MM-DD」「M/D」などが使えます",
  "  Google連携済みならGoogle Tasksにも追加されます",
  "・一覧  … 未通知のリマインダーを表示",
  "・削除 <ID>  … リマインダーを削除",
  "・今日 / 【タスク】  … 今日の予定とGoogle Tasksの未完了ToDoを表示",
  "・完了  … 未完了ToDoをボタン付きで表示し、押すと完了にできます",
  "",
  "＜Threads(別アカウント)自動投稿＞",
  "・スレッド予約 <日時> <本文>  例) スレッド予約 明日9:00 おはようございます",
  "・スレッド生成 <日時> <テーマ>  … AIが本文を作って予約 例) スレッド生成 明日12:00 今日の一言",
  "・スレッド投稿 <本文>  … いますぐ投稿",
  "・スレッド一覧 / スレッド削除 <ID>  … 予約の確認・取消",
  "",
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

// ---- Threads(Meta) OAuth ----
// 投稿したい「別アカウント」でこのURLにアクセスして認可する。
app.get("/threads/oauth/start", (c) => {
  const { THREADS_APP_ID } = c.env;
  if (!THREADS_APP_ID) {
    return c.text("THREADS_APP_ID が設定されていません。", 500);
  }
  const redirectUri = new URL("/threads/oauth/callback", c.req.url).toString();
  return c.redirect(buildThreadsAuthUrl(THREADS_APP_ID, redirectUri));
});

app.get("/threads/oauth/callback", async (c) => {
  const { THREADS_APP_ID, THREADS_APP_SECRET } = c.env;
  if (!THREADS_APP_ID || !THREADS_APP_SECRET) {
    return c.text("THREADS_APP_ID / THREADS_APP_SECRET が設定されていません。", 500);
  }
  const code = c.req.query("code");
  const error = c.req.query("error_description") ?? c.req.query("error");
  if (error) {
    return c.text(`Threads認証がキャンセルまたは失敗しました: ${error}`, 400);
  }
  if (!code) {
    return c.text("codeパラメータがありません。", 400);
  }
  const redirectUri = new URL("/threads/oauth/callback", c.req.url).toString();
  try {
    // Threadsはredirect_uriのcode末尾に "#_" が付与されることがあるため除去する
    const cleanCode = code.replace(/#_$/, "");
    const { username } = await exchangeThreadsCode(
      THREADS_APP_ID,
      THREADS_APP_SECRET,
      redirectUri,
      cleanCode,
      c.env.DB
    );
    const who = username ? `@${username}` : "対象アカウント";
    return c.text(`Threads連携が完了しました(${who})。このタブは閉じて大丈夫です。`);
  } catch (e) {
    return c.text(`Threads連携に失敗しました: ${(e as Error).message}`, 500);
  }
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

  if (trimmed.startsWith("スレッド")) {
    return await handleThreadsCommand(env, userId, trimmed, baseUrl);
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

// Threads関連コマンド(「スレッド〜」)を処理する。
async function handleThreadsCommand(
  env: Env,
  userId: string,
  trimmed: string,
  baseUrl: string
): Promise<CommandReply> {
  if (!env.THREADS_APP_ID || !env.THREADS_APP_SECRET) {
    return "Threads連携が未設定です。THREADS_APP_ID / THREADS_APP_SECRET を設定してください。";
  }
  const notConnected = `Threadsと連携されていません。\n投稿したいアカウントで ${baseUrl}/threads/oauth/start にアクセスして連携してください。`;

  // 予約一覧
  if (trimmed === "スレッド一覧" || trimmed === "スレッドリスト") {
    const posts = await listPendingThreadPosts(env.DB, userId);
    if (posts.length === 0) return "予約中のThreads投稿はありません。";
    return posts
      .map((p) => `#${p.id} ${formatJstDateTime(p.scheduled_at)}\n${p.text}`)
      .join("\n\n");
  }

  // 予約削除
  if (trimmed.startsWith("スレッド削除")) {
    const idStr = trimmed.replace("スレッド削除", "").trim();
    const id = Number(idStr);
    if (!idStr || Number.isNaN(id)) {
      return "取り消すThreads予約のIDを指定してください。例: スレッド削除 3";
    }
    const deleted = await deleteThreadPost(env.DB, userId, id);
    return deleted ? `Threads予約 #${id} を取り消しました。` : `#${id} は見つかりませんでした(既に投稿済み/存在しない)。`;
  }

  // いますぐ投稿
  if (trimmed.startsWith("スレッド投稿")) {
    const text = trimmed.replace("スレッド投稿", "").trim();
    if (!text) return "投稿する本文を指定してください。例: スレッド投稿 こんにちは";
    if (text.length > THREADS_TEXT_LIMIT) {
      return `本文が長すぎます(${text.length}文字)。Threadsは${THREADS_TEXT_LIMIT}文字までです。`;
    }
    const token = await getValidThreadsToken(env.DB).catch(() => null);
    if (!token) return notConnected;
    try {
      const { permalink } = await publishTextPost(token, text);
      const who = token.username ? `@${token.username}` : "";
      return `🧵 Threadsに投稿しました${who ? `(${who})` : ""}。${permalink ? `\n${permalink}` : ""}`;
    } catch (e) {
      return `Threadsへの投稿に失敗しました: ${(e as Error).message}`;
    }
  }

  // AIが本文を生成して予約
  if (trimmed.startsWith("スレッド生成")) {
    if (!env.ANTHROPIC_API_KEY) {
      return "AI生成には ANTHROPIC_API_KEY が必要です。";
    }
    const rest = trimmed.replace("スレッド生成", "").trim();
    const parsed = parseReminderInput(rest);
    if ("error" in parsed) {
      return `日時とテーマを指定してください。例: スレッド生成 明日12:00 今日の一言\n(${parsed.error})`;
    }
    let text: string;
    try {
      text = await generateThreadPost(env.ANTHROPIC_API_KEY, parsed.content, THREADS_TEXT_LIMIT);
    } catch (e) {
      return `本文の生成に失敗しました: ${(e as Error).message}`;
    }
    if (!text) return "本文を生成できませんでした。テーマを変えて試してください。";
    const id = await addThreadPost(env.DB, userId, text, parsed.dueAtUtcIso);
    return `🧵 AIが本文を作成し、Threads投稿を予約しました。\n#${id} ${formatJstDateTime(parsed.dueAtUtcIso)}\n\n${text}`;
  }

  // 予約投稿(本文は人が用意)
  if (trimmed.startsWith("スレッド予約")) {
    const rest = trimmed.replace("スレッド予約", "").trim();
    const parsed = parseReminderInput(rest);
    if ("error" in parsed) {
      return `日時と本文を指定してください。例: スレッド予約 明日9:00 おはようございます\n(${parsed.error})`;
    }
    if (parsed.content.length > THREADS_TEXT_LIMIT) {
      return `本文が長すぎます(${parsed.content.length}文字)。Threadsは${THREADS_TEXT_LIMIT}文字までです。`;
    }
    const id = await addThreadPost(env.DB, userId, parsed.content, parsed.dueAtUtcIso);
    return `🧵 Threads投稿を予約しました。\n#${id} ${formatJstDateTime(parsed.dueAtUtcIso)}\n\n${parsed.content}`;
  }

  return [
    "Threadsコマンド:",
    "・スレッド予約 <日時> <本文>",
    "・スレッド生成 <日時> <テーマ>  (AIが本文作成)",
    "・スレッド投稿 <本文>  (いますぐ)",
    "・スレッド一覧 / スレッド削除 <ID>",
  ].join("\n");
}

// 予約時刻を過ぎたThreads投稿をまとめて公開する。Cronから毎分呼ばれる。
async function runThreadPostsIfDue(env: Env): Promise<void> {
  if (!env.THREADS_APP_ID || !env.THREADS_APP_SECRET) return; // 連携未設定
  const now = new Date();
  const due = await getDueThreadPosts(env.DB, now.toISOString());
  if (due.length === 0) return;

  const token = await getValidThreadsToken(env.DB).catch(() => null);
  if (!token) return; // 未連携ならpendingのまま残し、連携後に自然に公開される

  const target = await getPushTargetUserId(env);
  for (const post of due) {
    try {
      const { permalink } = await publishTextPost(token, post.text);
      await markThreadPostPosted(env.DB, post.id, permalink);
      if (target) {
        const link = permalink ? `\n${permalink}` : "";
        await pushText(
          env.LINE_CHANNEL_ACCESS_TOKEN,
          target,
          `🧵 Threadsに自動投稿しました(#${post.id})${link}\n\n${post.text}`
        );
      }
    } catch (e) {
      const message = (e as Error).message;
      await markThreadPostFailed(env.DB, post.id, message);
      if (target) {
        await pushText(
          env.LINE_CHANNEL_ACCESS_TOKEN,
          target,
          `⚠️ Threadsへの自動投稿に失敗しました(#${post.id})。\n${message}`
        );
      }
    }
  }
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

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runReminderCheck(env));
    ctx.waitUntil(runThreadPostsIfDue(env));
    ctx.waitUntil(runDailyDigestIfDue(env));
    ctx.waitUntil(runProposalPrepIfDue(env));
    ctx.waitUntil(runInterviewPrepIfDue(env));
    ctx.waitUntil(runTomorrowPreviewIfDue(env));
  },
};
