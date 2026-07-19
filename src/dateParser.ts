// LINEのテキストコマンドに含まれる日本語の日時表現をJST基準で解釈し、
// UTCのISO 8601文字列に変換するユーティリティ。
// サポートする形式の例:
//   今日 21:00 / 明日9:00 / 明後日 18時30分 / 2026-07-20 15:00 / 7/20 15:00

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

interface JstParts {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
}

function toJstParts(date: Date): JstParts {
  const jst = new Date(date.getTime() + JST_OFFSET_MS);
  return {
    y: jst.getUTCFullYear(),
    m: jst.getUTCMonth() + 1,
    d: jst.getUTCDate(),
    h: jst.getUTCHours(),
    min: jst.getUTCMinutes(),
  };
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function buildUtcIso(y: number, m: number, d: number, h: number, min: number): string {
  const iso = `${y}-${pad2(m)}-${pad2(d)}T${pad2(h)}:${pad2(min)}:00+09:00`;
  return new Date(iso).toISOString();
}

type DatePart =
  | { kind: "offset"; days: number }
  | { kind: "explicit"; y: number; m: number; d: number }
  | { kind: "monthDay"; m: number; d: number };

function parseDatePart(token: string): DatePart | null {
  if (token === "今日") return { kind: "offset", days: 0 };
  if (token === "明日") return { kind: "offset", days: 1 };
  if (token === "明後日") return { kind: "offset", days: 2 };

  const explicit = token.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (explicit) {
    return {
      kind: "explicit",
      y: Number(explicit[1]),
      m: Number(explicit[2]),
      d: Number(explicit[3]),
    };
  }

  const monthDay = token.match(/^(\d{1,2})[\/月](\d{1,2})日?$/);
  if (monthDay) {
    return { kind: "monthDay", m: Number(monthDay[1]), d: Number(monthDay[2]) };
  }

  return null;
}

interface TimePart {
  h: number;
  min: number;
}

function parseTimePart(token: string): TimePart | null {
  const match = token.match(/^(\d{1,2})[:時](\d{0,2})分?$/);
  if (!match) return null;
  const h = Number(match[1]);
  const min = match[2] ? Number(match[2]) : 0;
  if (h > 23 || min > 59) return null;
  return { h, min };
}

function parseCombinedToken(token: string): { date: DatePart | null; time: TimePart | null } | null {
  const dateRe = "(今日|明日|明後日|\\d{4}[-\\/]\\d{1,2}[-\\/]\\d{1,2}|\\d{1,2}[\\/月]\\d{1,2}日?)";
  const timeRe = "(\\d{1,2}[:時]\\d{0,2}分?)";
  const re = new RegExp(`^${dateRe}?${timeRe}?$`);
  const match = token.match(re);
  if (!match) return null;
  const [, datePartRaw, timePartRaw] = match;
  if (!datePartRaw && !timePartRaw) return null;

  const date = datePartRaw ? parseDatePart(datePartRaw) : null;
  const time = timePartRaw ? parseTimePart(timePartRaw) : null;
  if (datePartRaw && !date) return null;
  if (timePartRaw && !time) return null;
  return { date, time };
}

export interface ParsedReminder {
  dueAtUtcIso: string;
  content: string;
}

export interface ParseError {
  error: string;
}

const DEFAULT_HOUR = 9;
const DEFAULT_MINUTE = 0;

function resolveDatePart(datePart: DatePart, now: Date): { y: number; m: number; d: number } {
  const nowJst = toJstParts(now);
  if (datePart.kind === "offset") {
    const baseUtcMs = Date.UTC(nowJst.y, nowJst.m - 1, nowJst.d);
    const target = new Date(baseUtcMs + datePart.days * 86400000);
    return { y: target.getUTCFullYear(), m: target.getUTCMonth() + 1, d: target.getUTCDate() };
  }
  if (datePart.kind === "explicit") {
    return { y: datePart.y, m: datePart.m, d: datePart.d };
  }
  // monthDay: 年が省略されているので今年を仮定し、既に過去なら来年に繰り上げる
  return { y: nowJst.y, m: datePart.m, d: datePart.d };
}

/**
 * 「追加」コマンドの残り文字列(日時 + 内容)を解釈する。
 * 例: "明日9:00 ゴミ出し" / "明日 9:00 ゴミ出し" / "2026-07-20 15:00 会議"
 */
export function parseReminderInput(rest: string, now: Date = new Date()): ParsedReminder | ParseError {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { error: "日時と内容を指定してください。例: 追加 明日9:00 ゴミ出し" };
  }

  // パターン1: 日付トークンと時刻トークンが別々 (例: "明日" "9:00" "ゴミ出し")
  if (tokens.length >= 2) {
    const datePart = parseDatePart(tokens[0]);
    const timePart = parseTimePart(tokens[1]);
    if (datePart && timePart && tokens.length >= 3) {
      const { y, m, d } = resolveDatePart(datePart, now);
      const dueAtUtcIso = buildUtcIso(y, m, timePart ? d : d, timePart.h, timePart.min);
      const content = tokens.slice(2).join(" ");
      return finalizeParsed(dueAtUtcIso, content, now);
    }
  }

  // パターン2: 日付+時刻が1トークンに結合 (例: "明日9:00" "ゴミ出し")
  const combined = parseCombinedToken(tokens[0]);
  if (combined && (combined.date || combined.time)) {
    const { y, m, d } = combined.date
      ? resolveDatePart(combined.date, now)
      : toJstParts(now);
    let year = y;
    let month = m;
    let day = d;
    if (combined.date && combined.date.kind === "monthDay") {
      const candidateUtc = buildUtcIso(
        year,
        month,
        day,
        combined.time?.h ?? DEFAULT_HOUR,
        combined.time?.min ?? DEFAULT_MINUTE
      );
      if (new Date(candidateUtc) <= now) {
        year += 1;
      }
    }
    const h = combined.time?.h ?? DEFAULT_HOUR;
    const min = combined.time?.min ?? DEFAULT_MINUTE;
    const dueAtUtcIso = buildUtcIso(year, month, day, h, min);
    const content = tokens.slice(1).join(" ");
    return finalizeParsed(dueAtUtcIso, content, now);
  }

  return { error: "日時を解釈できませんでした。例: 追加 明日9:00 ゴミ出し" };
}

function finalizeParsed(dueAtUtcIso: string, content: string, now: Date): ParsedReminder | ParseError {
  if (!content) {
    return { error: "リマインダーの内容を指定してください。例: 追加 明日9:00 ゴミ出し" };
  }
  if (new Date(dueAtUtcIso).getTime() <= now.getTime()) {
    return { error: "指定した日時は既に過ぎています。未来の日時を指定してください。" };
  }
  return { dueAtUtcIso, content };
}

export function formatJstDateTime(utcIso: string): string {
  const parts = toJstParts(new Date(utcIso));
  return `${parts.y}/${pad2(parts.m)}/${pad2(parts.d)} ${pad2(parts.h)}:${pad2(parts.min)}`;
}

/** 指定時刻をJSTとして見た「HH:MM」表記を返す（毎日ダイジェストの時刻比較用）。 */
export function currentJstHm(now: Date = new Date()): string {
  const parts = toJstParts(now);
  return `${pad2(parts.h)}:${pad2(parts.min)}`;
}

/** 指定時刻をJSTとして見た「YYYY-MM-DD」を返す（重複送信防止の日付キー等に使用）。 */
export function jstDateKey(now: Date = new Date()): string {
  const parts = toJstParts(now);
  return `${parts.y}-${pad2(parts.m)}-${pad2(parts.d)}`;
}

/** JSTの「今日」の範囲(00:00〜翌日00:00)をUTC ISO文字列で返す。Calendar APIのtimeMin/timeMax用。 */
export function jstTodayRangeUtc(now: Date = new Date()): { startUtcIso: string; endUtcIso: string } {
  const parts = toJstParts(now);
  const startUtcIso = buildUtcIso(parts.y, parts.m, parts.d, 0, 0);
  const nextDay = new Date(new Date(startUtcIso).getTime() + 86400000);
  return { startUtcIso, endUtcIso: nextDay.toISOString() };
}

/** JSTの「翌日」の範囲(翌日00:00〜翌々日00:00)をUTC ISO文字列で返す。 */
export function jstTomorrowRangeUtc(now: Date = new Date()): { startUtcIso: string; endUtcIso: string } {
  const parts = toJstParts(now);
  const todayStartUtc = new Date(buildUtcIso(parts.y, parts.m, parts.d, 0, 0));
  const startUtcIso = new Date(todayStartUtc.getTime() + 86400000).toISOString();
  const endUtcIso = new Date(todayStartUtc.getTime() + 2 * 86400000).toISOString();
  return { startUtcIso, endUtcIso };
}

/** UTC ISO文字列をJSTの「YYYY-MM-DD」日付部分のみに変換する。Google Tasksのdueフィールド用。 */
export function jstDateOnlyUtc(utcIso: string): string {
  const parts = toJstParts(new Date(utcIso));
  return buildUtcIso(parts.y, parts.m, parts.d, 0, 0);
}

/** "YYYY-MM-DD" と "HH:MM" (JST) をUTC ISO文字列に変換する。AIツール入力用。 */
export function jstStringsToUtcIso(dateStr: string, timeStr: string): string | null {
  const dateMatch = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const timeMatch = timeStr.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!dateMatch || !timeMatch) return null;
  const h = Number(timeMatch[1]);
  const min = Number(timeMatch[2]);
  if (h > 23 || min > 59) return null;
  return buildUtcIso(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]), h, min);
}

/** 現在時刻をJST表記の文字列で返す。AIのシステムプロンプト用。 */
export function currentJstString(now: Date = new Date()): string {
  const parts = toJstParts(now);
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const dayOfWeek = new Date(now.getTime() + 9 * 60 * 60 * 1000).getUTCDay();
  return `${parts.y}年${parts.m}月${parts.d}日(${weekdays[dayOfWeek]}) ${pad2(parts.h)}:${pad2(parts.min)}`;
}
