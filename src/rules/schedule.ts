import { Cron } from "croner";

// Cron schedules for SCHEDULE rules and later(), read in a time zone with
// croner. Only the usual five fields (minute hour day month weekday) and the @
// aliases are taken, so nothing runs more often than once a minute.

export const DEFAULT_TIMEZONE = "Asia/Tokyo";

/** A schedule as croner reads it, paused: only for working out its runs. Throws with a readable reason. */
export function parseCron(expression: string, timezone = DEFAULT_TIMEZONE): Cron {
  const text = expression.trim();
  if (!text.startsWith("@") && text.split(/\s+/).length !== 5) throw new Error("cron は「分 時 日 月 曜日」の5つの欄で書いてください(例: 0 4 * * *)");
  try {
    return new Cron(text, { timezone, paused: true });
  } catch (e) {
    throw new Error(`cron の「${text}」が読めません(${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Runs `fn` on every match of the schedule until stopped. The expression must have passed parseCron. */
export function startCron(expression: string, timezone: string, fn: () => void): { stop(): void } {
  return new Cron(expression.trim(), { timezone, protect: true }, fn);
}

export function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Problems with a schedule, for the proposal. */
export function scheduleProblems(cron: string | undefined, tz: string | undefined): string[] {
  const problems: string[] = [];
  if (!cron) return ["きっかけ SCHEDULE には schedule(cron)が必要です"];
  if (tz !== undefined && !isTimezone(tz)) return [`きっかけの timezone ${tz} は使えません(例: Asia/Tokyo)`];
  try {
    if (!parseCron(cron, tz).nextRun()) problems.push(`きっかけの schedule: cron の「${cron}」に当てはまる日時がありません`);
  } catch (e) {
    problems.push(`きっかけの schedule: ${e instanceof Error ? e.message : String(e)}`);
  }
  return problems;
}
