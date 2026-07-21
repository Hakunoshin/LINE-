// 成約報酬くらべ LINE bot (単体ワーカー)。
// 企業名を送ると circus / peterpan / trueaim の成約報酬を比較し、
// 一番報酬が高い媒体を返す。個人用リマインダーbotとは別チャネル・別ワーカー。

import { Hono } from "hono";
import { verifyLineSignature, replyText, type LineWebhookBody } from "./line";
import { compareReward, formatComparison } from "./rewards";
import { PAGE } from "./page";

export interface Env {
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
  // 未設定なら誰からのメッセージにも応答する。自分専用にするなら自分のuserIdを設定。
  ALLOWED_USER_ID?: string;
  // circus 自動ログイン用 (任意)。設定すると理論年収を circus から取得しようとする。
  CIRCUS_EMAIL?: string;
  CIRCUS_PASSWORD?: string;
}

const HELP_TEXT = [
  "成約報酬くらべ bot",
  "",
  "企業名を送ると circus / peterpan / trueaim で",
  "成約報酬が一番高い媒体を返します。",
  "",
  "例) 株式会社レオパレス21 理論年収500万",
  "",
  "・企業名はできるだけフルネームで。",
  "・料率型(理論年収×◯%)を金額換算するには理論年収が必要です。",
  "  「理論年収500万」または「500万」を付けて送ってください。",
].join("\n");

const app = new Hono<{ Bindings: Env }>();

// Web UI (ブラウザで開く専用チャット画面)
app.get("/", (c) => c.html(PAGE));

// 企業名を受け取り比較結果をJSONで返す。Web UIから呼ばれる。
app.get("/api/compare", async (c) => {
  const company = (c.req.query("company") ?? "").trim();
  if (!company) {
    return c.json({ error: "company is required" }, 400);
  }
  const theoryRaw = c.req.query("theory");
  const theoryMan = theoryRaw != null && theoryRaw !== "" ? Number(theoryRaw) : null;
  try {
    const result = await compareReward(c.env, company, Number.isFinite(theoryMan as number) ? theoryMan : null);
    return c.json(result);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
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
    if (event.type !== "message" || event.message?.type !== "text" || !event.replyToken) {
      continue;
    }
    const userId = event.source.userId;
    if (!userId) continue;
    if (c.env.ALLOWED_USER_ID && userId !== c.env.ALLOWED_USER_ID) continue;

    const text = event.message.text ?? "";
    const reply = await handleMessage(c.env, text);
    await replyText(c.env.LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, reply);
  }

  return c.text("ok");
});

// 「株式会社◯◯ 理論年収500万」から企業名と理論年収(万円)を分離する。
function parseCompanyAndTheory(text: string): { company: string; theoryMan: number | null } {
  let theoryMan: number | null = null;
  let company = text;
  const m = text.match(/(?:理論年収|年収)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*万?/);
  if (m) {
    theoryMan = parseFloat(m[1]);
    company = text.replace(m[0], "");
  } else {
    const m2 = text.match(/(\d{3,4})\s*万/);
    if (m2) {
      theoryMan = parseFloat(m2[1]);
      company = text.replace(m2[0], "");
    }
  }
  return { company: company.trim(), theoryMan };
}

async function handleMessage(env: Env, text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "ヘルプ" || trimmed === "help" || trimmed === "使い方") {
    return HELP_TEXT;
  }

  const { company, theoryMan } = parseCompanyAndTheory(trimmed);
  if (!company) {
    return "企業名を読み取れませんでした。\n" + HELP_TEXT;
  }
  try {
    const result = await compareReward(env, company, theoryMan);
    return formatComparison(result);
  } catch (e) {
    return `報酬比較に失敗しました: ${(e as Error).message}`;
  }
}

export default {
  fetch: app.fetch,
};
