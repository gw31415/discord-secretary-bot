// Cron schedules for SCHEDULE rules: five fields (minute hour day month weekday)
// read in a time zone, checked once a minute by the engine. No dependency: the
// syntax is the common subset (*, lists, ranges, steps, and a few @ aliases).

export const DEFAULT_TIMEZONE = "Asia/Tokyo";

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  /** Day and weekday both restricted: either may match, as in standard cron. */
  dayOrWeekday: boolean;
}

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

const FIELDS: Array<{ name: string; min: number; max: number }> = [
  { name: "分", min: 0, max: 59 },
  { name: "時", min: 0, max: 23 },
  { name: "日", min: 1, max: 31 },
  { name: "月", min: 1, max: 12 },
  { name: "曜日", min: 0, max: 7 },
];

function parseField(text: string, field: (typeof FIELDS)[number]): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`${field.name}の「${part}」が読めません`);
    const step = m[4] ? Number(m[4]) : 1;
    const from = m[1] === "*" ? field.min : Number(m[2]);
    const to = m[1] === "*" ? field.max : m[3] !== undefined ? Number(m[3]) : m[4] ? field.max : from;
    if (step < 1 || from < field.min || to > field.max || from > to) throw new Error(`${field.name}の「${part}」が範囲(${field.min}〜${field.max})の外です`);
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

/** Throws with a readable reason when the expression is not valid. */
export function parseCron(expression: string): Cron {
  const text = ALIASES[expression.trim()] ?? expression.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new Error("cron は「分 時 日 月 曜日」の5つの欄で書いてください(例: 0 4 * * *)");
  const [minute, hour, day, month, weekday] = parts.map((p, i) => parseField(p, FIELDS[i]!)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (weekday.delete(7)) weekday.add(0);
  return { minute, hour, day, month, weekday, dayOrWeekday: parts[2] !== "*" && parts[4] !== "*" };
}

export function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The wall-clock fields of `time` in `tz`. */
function wallClock(time: number, tz: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" })
      .formatToParts(new Date(time))
      .map((p) => [p.type, p.value]),
  );
  return { minute: Number(parts.minute), hour: Number(parts.hour), day: Number(parts.day), month: Number(parts.month), weekday: WEEKDAYS.indexOf(parts.weekday!) };
}

/** Whether the minute containing `time` is one the schedule fires on. */
export function cronMatches(cron: Cron, time: number, tz: string): boolean {
  const t = wallClock(time, tz);
  if (!cron.minute.has(t.minute) || !cron.hour.has(t.hour) || !cron.month.has(t.month)) return false;
  const day = cron.day.has(t.day);
  const weekday = cron.weekday.has(t.weekday);
  return cron.dayOrWeekday ? day || weekday : day && weekday;
}

/** Problems with a schedule, for the proposal. */
export function scheduleProblems(cron: string | undefined, tz: string | undefined): string[] {
  const problems: string[] = [];
  if (!cron) return ["きっかけ SCHEDULE には schedule(cron)が必要です"];
  try {
    parseCron(cron);
  } catch (e) {
    problems.push(`きっかけの schedule: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (tz !== undefined && !isTimezone(tz)) problems.push(`きっかけの timezone ${tz} は使えません(例: Asia/Tokyo)`);
  return problems;
}
