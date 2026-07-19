// LINEの自由文メッセージをClaudeが処理するAIエージェント。
// リマインダー操作・今日の予定取得をツールとして持ち、短い日本語で返信する。

import Anthropic from "@anthropic-ai/sdk";
import { addReminder, listPendingReminders, deleteReminder, getChatHistory, appendChatHistory } from "./db";
import { formatJstDateTime, currentJstString, jstStringsToUtcIso, jstDateOnlyUtc } from "./dateParser";
import { insertTask } from "./google";
import { compareReward, formatComparison } from "./rewards";

// LINEのテキストメッセージ上限は5000文字
const LINE_TEXT_LIMIT = 4900;
const HISTORY_LIMIT = 20;
const MAX_TOOL_ITERATIONS = 5;

export interface AiContext {
  db: D1Database;
  userId: string;
  googleAccessToken: string | null;
  buildTodayDigest: (accessToken: string) => Promise<string>;
  rewardEnv: { CIRCUS_EMAIL?: string; CIRCUS_PASSWORD?: string };
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "add_reminder",
    description:
      "リマインダーを登録する。ユーザーが「〜をリマインドして」「〜を覚えておいて」「〜時に教えて」等、日時と内容を伴う依頼をしたときに呼ぶ。日時が曖昧な場合は呼ぶ前にユーザーに確認すること。",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "リマインダーの内容" },
        date_jst: { type: "string", description: "JSTの日付。YYYY-MM-DD形式" },
        time_jst: { type: "string", description: "JSTの時刻。HH:MM形式。指定がなければ09:00" },
      },
      required: ["content", "date_jst", "time_jst"],
    },
  },
  {
    name: "list_reminders",
    description: "登録済みで未通知のリマインダー一覧を取得する。ユーザーが予定やタスクの確認を求めたときに呼ぶ。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "delete_reminder",
    description: "指定IDのリマインダーを削除する。IDが不明な場合は先にlist_remindersで確認する。",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "削除するリマインダーのID" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_today_digest",
    description:
      "Googleカレンダーの今日の予定とGoogle Tasksの未完了ToDoの一覧を取得する。今日の予定・タスクについて聞かれたときに呼ぶ。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "compare_placement_reward",
    description:
      "ある企業の人材紹介の成約報酬を circus / peterpan / trueaim の3媒体で比較し、一番報酬が高い媒体を返す。ユーザーが企業名を挙げて「どこが一番報酬高い?」「◯◯の報酬比べて」等と聞いたときに呼ぶ。料率型(理論年収×◯%)の報酬を金額換算するには理論年収が必要。ユーザーが理論年収を言っていれば theory_income_man に渡す。",
    input_schema: {
      type: "object",
      properties: {
        company_name: { type: "string", description: "比較したい企業名。できるだけフルネーム" },
        theory_income_man: {
          type: "number",
          description: "理論年収(万円)。ユーザーが指定した場合のみ。例: 500 は500万円",
        },
      },
      required: ["company_name"],
    },
  },
];

async function executeTool(ctx: AiContext, name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "add_reminder": {
      const content = String(input.content ?? "");
      const dueAtUtcIso = jstStringsToUtcIso(String(input.date_jst ?? ""), String(input.time_jst ?? ""));
      if (!content || !dueAtUtcIso) {
        return "エラー: content, date_jst(YYYY-MM-DD), time_jst(HH:MM) を正しく指定してください。";
      }
      if (new Date(dueAtUtcIso).getTime() <= Date.now()) {
        return "エラー: 指定日時は過去です。未来の日時を指定してください。";
      }
      const id = await addReminder(ctx.db, ctx.userId, content, dueAtUtcIso);
      let googleNote = "";
      if (ctx.googleAccessToken) {
        try {
          const timePart = formatJstDateTime(dueAtUtcIso).split(" ")[1];
          await insertTask(ctx.googleAccessToken, `[${timePart}] ${content}`, jstDateOnlyUtc(dueAtUtcIso));
          googleNote = " Google Tasksにも追加済み。";
        } catch {
          googleNote = " (Google Tasksへの追加は失敗)";
        }
      }
      return `登録完了: #${id} ${formatJstDateTime(dueAtUtcIso)} ${content}。${googleNote}`;
    }
    case "list_reminders": {
      const reminders = await listPendingReminders(ctx.db, ctx.userId);
      if (reminders.length === 0) return "未通知のリマインダーはありません。";
      return reminders.map((r) => `#${r.id} ${formatJstDateTime(r.due_at)} ${r.content}`).join("\n");
    }
    case "delete_reminder": {
      const id = Number(input.id);
      if (Number.isNaN(id)) return "エラー: idを整数で指定してください。";
      const deleted = await deleteReminder(ctx.db, ctx.userId, id);
      return deleted ? `#${id} を削除しました。` : `#${id} は見つかりませんでした。`;
    }
    case "get_today_digest": {
      if (!ctx.googleAccessToken) {
        return "Google未連携のため取得できません。ユーザーに /oauth/start での連携を案内してください。";
      }
      try {
        return await ctx.buildTodayDigest(ctx.googleAccessToken);
      } catch (e) {
        return `取得に失敗しました: ${(e as Error).message}`;
      }
    }
    case "compare_placement_reward": {
      const company = String(input.company_name ?? "").trim();
      if (!company) return "エラー: company_name を指定してください。";
      const theory =
        typeof input.theory_income_man === "number" ? input.theory_income_man : null;
      try {
        const result = await compareReward(ctx.rewardEnv, company, theory);
        return formatComparison(result);
      } catch (e) {
        return `報酬比較に失敗しました: ${(e as Error).message}`;
      }
    }
    default:
      return `エラー: 不明なツール ${name}`;
  }
}

function buildSystemPrompt(): string {
  return [
    "あなたはLINE上で動く、ユーザー専属のパーソナルアシスタントです。",
    `現在の日時: ${currentJstString()} (JST)`,
    "",
    "役割:",
    "- リマインダー/タスクの登録・確認・削除(ツールを使う)",
    "- 今日の予定・ToDoの確認(ツールを使う)",
    "- 企業の成約報酬をcircus/peterpan/trueaimで比較(compare_placement_rewardツールを使う)",
    "- それ以外の質問や雑談にも普通に応じる",
    "",
    "返信のルール:",
    "- LINEのトークなので、短く自然な日本語で返す。長くても数行。",
    "- Markdown記法(見出し、太字、箇条書き記号の*等)は使わない。プレーンテキストのみ。",
    "- 日時の解釈はJST基準。「明日」「来週月曜」等は現在日時から計算する。",
    "- リマインダー登録時、日時が曖昧なら登録前に確認する。",
  ].join("\n");
}

/** 自由文メッセージをClaudeで処理して返信テキストを返す。 */
export async function handleWithAi(apiKey: string, ctx: AiContext, userText: string): Promise<string> {
  const client = new Anthropic({ apiKey });

  const history = await getChatHistory(ctx.db, ctx.userId, HISTORY_LIMIT);
  const messages: Anthropic.MessageParam[] = [
    ...history.map((m): Anthropic.MessageParam => ({ role: m.role, content: m.content })),
    { role: "user", content: userText },
  ];

  let finalText = "";
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages,
    });

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      finalText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      break;
    }

    messages.push({ role: "assistant", content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const result = await executeTool(ctx, block.name, block.input as Record<string, unknown>);
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }

  if (!finalText) {
    finalText = "すみません、処理がうまくいきませんでした。もう一度試してください。";
  }
  if (finalText.length > LINE_TEXT_LIMIT) {
    finalText = finalText.slice(0, LINE_TEXT_LIMIT) + "…";
  }

  await appendChatHistory(ctx.db, ctx.userId, "user", userText);
  await appendChatHistory(ctx.db, ctx.userId, "assistant", finalText);

  return finalText;
}
