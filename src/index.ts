import { Hono } from "hono";
import { verifyLineSignature, replyText, pushText, replyFlex, pushFlex, type LineWebhookBody } from "./line";
import {
  addReminder,
  listPendingReminders,
  deleteReminder,
  getDueReminders,
  markNotified,
  getAppState,
  setAppState,
  addXSeed,
  listXSeeds,
  deleteXSeed,
  addXDraft,
  getXDraft,
  listXDraftsByStatus,
  approveXDraft,
  rejectXDraft,
  getDueApprovedXDrafts,
  markXDraftPosted,
  type XDraft,
} from "./db";
import {
  generateXDrafts,
  groupSeeds,
  getXCredentials,
  postToX,
  buildDraftFlex,
  buildXSettingsText,
  X_HELP_TEXT,
} from "./x";
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
  // ===== X(旧Twitter)自動運用チーム =====
  // 発信テーマ(未設定なら「転職・キャリア」)
  X_TOPIC?: string;
  // 投稿案を自動生成してLINEに送る時刻(JST, "HH:MM"。未設定なら08:00)
  X_GENERATE_TIME_JST?: string;
  // 1回の自動生成で作る投稿案の件数(未設定なら3, 最大5)
  X_DRAFTS_PER_RUN?: string;
  // X API v2への投稿用(OAuth1.0a)。4つ揃うと承認済み投稿を自動でXへ投稿する。未設定なら手動投稿。
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_TOKEN_SECRET?: string;
}

const DEFAULT_DIGEST_TIMES = ["07:30", "13:00", "18:00"];

// ===== X運用チームの既定値 =====
const X_DEFAULT_TOPIC = "転職・キャリア";
const X_DEFAULT_GENERATE_TIME = "08:00";
const X_DEFAULT_PER_RUN = 3;
const X_MAX_PER_RUN = 5;

function xTopic(env: Env): string {
  return env.X_TOPIC?.trim() || X_DEFAULT_TOPIC;
}
function xGenerateTime(env: Env): string {
  return env.X_GENERATE_TIME_JST?.trim() || X_DEFAULT_GENERATE_TIME;
}
function xPerRun(env: Env): number {
  const n = Number(env.X_DRAFTS_PER_RUN);
  if (!Number.isFinite(n) || n <= 0) return X_DEFAULT_PER_RUN;
  return Math.min(Math.floor(n), X_MAX_PER_RUN);
}
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
  "・Xヘルプ  … X(旧Twitter)自動運用チームの使い方",
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

    // ボタン(ポストバック: ToDo完了 / X投稿案の承認・却下・別案)を処理する
    if (event.type === "postback" && event.postback) {
      const reply = await handlePostback(c.env, userId, event.postback.data);
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

// ポストバックを処理する。ToDo完了(done:) と X投稿案の承認/却下/別案(x_approve: 等)。
async function handlePostback(env: Env, userId: string, data: string): Promise<string> {
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
  if (data.startsWith("x_approve:")) {
    return await handleXApprove(env, userId, Number(data.slice("x_approve:".length)));
  }
  if (data.startsWith("x_reject:")) {
    return await handleXReject(env, userId, Number(data.slice("x_reject:".length)));
  }
  if (data.startsWith("x_regen:")) {
    return await handleXRegen(env, userId, Number(data.slice("x_regen:".length)));
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

// ===== X運用チーム =====

// ネタ元をもとに投稿案を生成し、承認ボタン付きカードをLINEに送る。生成件数を返す。
// referenceを渡すと、その投稿を参考(型の元)として1件だけ生成する。
async function generateAndDeliverXDrafts(
  env: Env,
  userId: string,
  count: number,
  reference?: string
): Promise<number> {
  if (!env.ANTHROPIC_API_KEY) return 0;
  const seeds = await listXSeeds(env.DB, userId);
  const grouped = groupSeeds(seeds);
  const references = [...grouped.references];
  if (reference) references.push(reference);

  const posts = await generateXDrafts(env.ANTHROPIC_API_KEY, {
    topic: xTopic(env),
    accounts: grouped.accounts,
    keywords: grouped.keywords,
    references,
    count,
  });

  const sourceNote = reference ? "参考投稿から生成" : "ネタ元から生成";
  let delivered = 0;
  for (const post of posts) {
    const id = await addXDraft(env.DB, userId, post.content, post.rationale, sourceNote);
    const flex = buildDraftFlex({ id, content: post.content, rationale: post.rationale });
    await pushFlex(env.LINE_CHANNEL_ACCESS_TOKEN, userId, flex.altText, flex.contents);
    delivered++;
  }
  return delivered;
}

// 承認済みドラフトを投稿する。X API連携済みなら自動投稿し、未連携なら手動投稿用の案内文を返す。
async function postApprovedDraft(env: Env, draft: XDraft): Promise<string> {
  const creds = getXCredentials(env);
  if (!creds) {
    // 未連携: 本文をそのまま返して手動コピー投稿してもらう(status=approvedのまま=手動キュー)
    return `✅ 承認しました(#${draft.id})。X未連携のため、以下をコピーしてXに投稿してください。\n\n${draft.content}`;
  }
  try {
    const tweetId = await postToX(creds, draft.content);
    await markXDraftPosted(env.DB, draft.id, new Date().toISOString());
    const url = tweetId ? `\nhttps://x.com/i/web/status/${tweetId}` : "";
    return `🐦 Xに投稿しました(#${draft.id})。${url}`;
  } catch (e) {
    return `投稿に失敗しました(#${draft.id}): ${(e as Error).message}\n承認済みのままなので、後で自動的に再試行されます。`;
  }
}

// 承認処理(ボタン/コマンド共通)。承認→(連携済みなら)投稿、まで行う。
async function handleXApprove(env: Env, userId: string, id: number): Promise<string> {
  const draft = await getXDraft(env.DB, userId, id);
  if (!draft) return `#${id} の投稿案は見つかりませんでした。`;
  if (draft.status === "posted") return `#${id} は既に投稿済みです。`;
  if (draft.status === "approved") return await postApprovedDraft(env, draft);
  if (draft.status !== "pending") return `#${id} は承認できない状態です(${draft.status})。`;
  await approveXDraft(env.DB, userId, id, new Date().toISOString());
  const updated = await getXDraft(env.DB, userId, id);
  return await postApprovedDraft(env, updated ?? draft);
}

async function handleXReject(env: Env, userId: string, id: number): Promise<string> {
  const ok = await rejectXDraft(env.DB, userId, id);
  return ok ? `#${id} を却下しました。` : `#${id} は却下できませんでした(承認待ちの案のみ却下できます)。`;
}

// 別案: 元の案を却下し、同じネタ元から作り直して1件送る。
async function handleXRegen(env: Env, userId: string, id: number): Promise<string> {
  const draft = await getXDraft(env.DB, userId, id);
  if (draft && draft.status === "pending") {
    await rejectXDraft(env.DB, userId, id);
  }
  if (!env.ANTHROPIC_API_KEY) return "AI(ANTHROPIC_API_KEY)が未設定のため作り直せません。";
  const reference = draft ? draft.content : undefined;
  const n = await generateAndDeliverXDrafts(env, userId, 1, reference);
  return n > 0 ? "別案を作りました。上のカードで承認/却下を選んでください。" : "別案の生成に失敗しました。";
}

function xStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "承認待ち";
    case "approved":
      return "承認済(投稿待ち/手動)";
    case "posted":
      return "投稿済";
    default:
      return status;
  }
}

// Xコマンドを処理する。Xコマンドでなければnullを返す(通常のコマンド/AI処理に流す)。
async function handleXCommand(env: Env, userId: string, trimmed: string): Promise<CommandReply | null> {
  if (trimmed === "Xヘルプ" || trimmed === "xヘルプ" || trimmed === "Ｘヘルプ") {
    return X_HELP_TEXT;
  }

  if (trimmed === "X設定" || trimmed === "x設定") {
    const seeds = await listXSeeds(env.DB, userId);
    return buildXSettingsText(seeds, {
      apiConnected: getXCredentials(env) !== null,
      topic: xTopic(env),
      generateTime: xGenerateTime(env),
      perRun: xPerRun(env),
    });
  }

  if (trimmed.startsWith("Xアカウント") || trimmed.startsWith("xアカウント")) {
    const value = trimmed.replace(/^[Xx]アカウント/, "").trim();
    if (!value) return "参考にするアカウントを指定してください。例: Xアカウント @example";
    const normalized = value.startsWith("@") ? value : `@${value}`;
    const id = await addXSeed(env.DB, userId, "account", normalized);
    return `参考アカウントを登録しました(#${id} ${normalized})。`;
  }

  if (trimmed.startsWith("Xキーワード") || trimmed.startsWith("xキーワード")) {
    const value = trimmed.replace(/^[Xx]キーワード/, "").trim();
    if (!value) return "キーワードを指定してください。例: Xキーワード 20代 転職";
    const id = await addXSeed(env.DB, userId, "keyword", value);
    return `キーワードを登録しました(#${id} ${value})。`;
  }

  if (trimmed.startsWith("Xネタ元削除") || trimmed.startsWith("xネタ元削除")) {
    const idStr = trimmed.replace(/^[Xx]ネタ元削除/, "").trim();
    const id = Number(idStr);
    if (!idStr || Number.isNaN(id)) return "削除するネタ元の番号を指定してください。例: Xネタ元削除 3";
    const ok = await deleteXSeed(env.DB, userId, id);
    return ok ? `ネタ元 #${id} を削除しました。` : `#${id} は見つかりませんでした。`;
  }

  if (trimmed === "X案" || trimmed === "x案" || trimmed === "Xネタ" || trimmed === "xネタ") {
    if (!env.ANTHROPIC_API_KEY) return "AI(ANTHROPIC_API_KEY)が未設定のため投稿案を作れません。";
    const n = await generateAndDeliverXDrafts(env, userId, xPerRun(env));
    return n > 0
      ? `${n}件の投稿案を送りました。各カードで承認/別案/却下を選んでください。`
      : "投稿案の生成に失敗しました。少し時間をおいて再度お試しください。";
  }

  if (trimmed === "Xキュー" || trimmed === "xキュー") {
    const drafts = await listXDraftsByStatus(env.DB, userId, ["pending", "approved"]);
    if (drafts.length === 0) return "承認待ち/投稿待ちの投稿案はありません。「X案」で作成できます。";
    const lines = drafts.map((d) => {
      const head = d.content.length > 30 ? d.content.slice(0, 30) + "…" : d.content;
      return `#${d.id} [${xStatusLabel(d.status)}] ${head}`;
    });
    return ["🐦 投稿キュー", ...lines].join("\n");
  }

  const approveMatch = trimmed.match(/^[Xx]承認\s*(\d+)$/);
  if (approveMatch) return await handleXApprove(env, userId, Number(approveMatch[1]));

  const rejectMatch = trimmed.match(/^[Xx]却下\s*(\d+)$/);
  if (rejectMatch) return await handleXReject(env, userId, Number(rejectMatch[1]));

  const regenMatch = trimmed.match(/^[Xx]別案\s*(\d+)$/);
  if (regenMatch) return await handleXRegen(env, userId, Number(regenMatch[1]));

  return null;
}

async function handleCommand(env: Env, userId: string, text: string, baseUrl: string): Promise<CommandReply> {
  const trimmed = text.trim();

  const xReply = await handleXCommand(env, userId, trimmed);
  if (xReply !== null) return xReply;

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

  // コマンドに一致しない自由文はClaude(AI)が処理する
  if (env.ANTHROPIC_API_KEY) {
    try {
      const accessToken = await getAccessTokenOrNull(env);
      return await handleWithAi(env.ANTHROPIC_API_KEY, {
        db: env.DB,
        userId,
        googleAccessToken: accessToken,
        buildTodayDigest,
        draftXPosts: async (reference) => {
          const n = await generateAndDeliverXDrafts(env, userId, reference ? 1 : xPerRun(env), reference);
          return n > 0
            ? `${n}件の投稿案をLINEに送りました。カードで承認/別案/却下を選べます。`
            : "投稿案の生成に失敗しました。";
        },
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

// 毎日決まった時刻(既定08:00 JST)に、登録済みネタ元から投稿案を自動生成してLINEに送る。
// ネタ元が未登録の場合は送らない(意図しない自動投稿案を防ぐ)。
async function runXDailyGenerateIfDue(env: Env): Promise<void> {
  const now = new Date();
  if (currentJstHm(now) !== xGenerateTime(env)) return;
  if (!env.ANTHROPIC_API_KEY) return;

  const target = await getPushTargetUserId(env);
  if (!target) return;

  const todayKey = jstDateKey(now);
  const lastKey = await getAppState(env.DB, "last_x_generate_date");
  if (lastKey === todayKey) return; // その日は生成済み

  const seeds = await listXSeeds(env.DB, target);
  if (seeds.length === 0) {
    // ネタ元が無ければ自動生成はしない。処理済みとして記録し翌日まで再実行しない。
    await setAppState(env.DB, "last_x_generate_date", todayKey);
    return;
  }

  try {
    await generateAndDeliverXDrafts(env, target, xPerRun(env));
    await setAppState(env.DB, "last_x_generate_date", todayKey);
  } catch {
    // 失敗時はstate未更新のまま次の分に再試行される
  }
}

// 承認済みで投稿予定時刻を過ぎたドラフトをXへ投稿する。X API未連携なら何もしない(手動キューとして残る)。
async function runXScheduledPostsIfDue(env: Env): Promise<void> {
  const creds = getXCredentials(env);
  if (!creds) return;

  const now = new Date();
  const due = await getDueApprovedXDrafts(env.DB, now.toISOString());
  for (const draft of due) {
    try {
      const tweetId = await postToX(creds, draft.content);
      await markXDraftPosted(env.DB, draft.id, new Date().toISOString());
      const url = tweetId ? `\nhttps://x.com/i/web/status/${tweetId}` : "";
      await pushText(env.LINE_CHANNEL_ACCESS_TOKEN, draft.user_id, `🐦 Xに自動投稿しました(#${draft.id})。${url}`);
    } catch {
      // 失敗時はstatus=approvedのままなので次の分に自然に再試行される
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
    ctx.waitUntil(runXDailyGenerateIfDue(env));
    ctx.waitUntil(runXScheduledPostsIfDue(env));
  },
};
