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
} from "./db";
import { parseReminderInput, formatJstDateTime, currentJstHm, jstDateKey, jstTodayRangeUtc, jstDateOnlyUtc } from "./dateParser";
import {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  getValidAccessToken,
  listTodayEvents,
  listIncompleteTasks,
  insertTask,
} from "./google";
import { handleWithAi } from "./ai";

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
}

const DEFAULT_DIGEST_TIMES = ["07:30", "13:00", "18:00"];
const TASK_COMMAND = "【タスク】";

const HELP_TEXT = [
  "使えるコマンド:",
  "・追加 <日時> <内容>  例) 追加 明日9:00 ゴミ出し",
  "  日時は「今日/明日/明後日」「HH:MM」「YYYY-MM-DD」「M/D」などが使えます",
  "  Google連携済みならGoogle Tasksにも追加されます",
  "・一覧  … 未通知のリマインダーを表示",
  "・削除 <ID>  … リマインダーを削除",
  "・今日 / 【タスク】  … 今日の予定とGoogle Tasksの未完了ToDoを表示",
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

    const text = event.message.text ?? "";
    const baseUrl = new URL(c.req.url).origin;
    const reply = await handleCommand(c.env, userId, text, baseUrl);
    await replyText(c.env.LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, reply);
  }

  return c.text("ok");
});

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
  if (!env.ALLOWED_USER_ID) return; // 送信先が確定できない場合は何もしない

  const now = new Date();
  const nowHm = currentJstHm(now);
  if (!getDigestTimes(env).includes(nowHm)) return;

  // 「日付+時刻」単位で送信済みかを記録し、同じ時刻枠での二重送信(cron再試行等)を防ぐ
  const sentKey = `${jstDateKey(now)} ${nowHm}`;
  const lastSentKey = await getAppState(env.DB, "last_digest_sent_at");
  if (lastSentKey === sentKey) return;

  const accessToken = await getAccessTokenOrNull(env);
  if (!accessToken) return; // 未連携ならダイジェストは送らない

  try {
    const digest = await buildTodayDigest(accessToken);
    await pushText(env.LINE_CHANNEL_ACCESS_TOKEN, env.ALLOWED_USER_ID, digest);
    await setAppState(env.DB, "last_digest_sent_at", sentKey);
  } catch {
    // 取得失敗時は次の分に自然に再試行される(state未更新のため)
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runReminderCheck(env));
    ctx.waitUntil(runDailyDigestIfDue(env));
  },
};
