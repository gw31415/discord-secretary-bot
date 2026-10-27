import { Cron } from "croner";
import { DateTime, Duration } from "luxon";

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

/**
 * The next time an ISO 8601 value names after `now`, read with luxon in
 * `timezone` when it has no offset: a duration from now (PT10M), a date and/or
 * time in any of the standard's forms (calendar, week, ordinal, basic or
 * extended, a time alone meaning today), an interval (its start; start/end,
 * start/duration, duration/end, and an end shortened to the fields that change)
 * or a repeating interval (R5/2026-10-28T09:00/PT1H: its next start).
 * Null when the value names no time after `now`; throws when it is not ISO 8601.
 */
export function isoNext(text: string, timezone: string, now: number): number | null {
  const zone = { zone: timezone };
  const from = DateTime.fromMillis(now, zone);
  const fail = (): never => {
    throw new Error(`ISO 8601 の「${text}」が読めません(例: PT10M、2026-10-28T09:00+09:00、R/2026-10-28T09:00/P1D)`);
  };
  const duration = (part: string): Duration => {
    const d = Duration.fromISO(part);
    return d.isValid && d.toMillis() > 0 ? d : fail();
  };
  const time = (part: string, base?: DateTime): DateTime => {
    let at = DateTime.fromISO(part.replace(/^T/, ""), zone);
    // A time alone is today; an interval's shortened end takes the fields it leaves out from the start.
    if (at.isValid && !/^\d{4}|^\d{8}|^\+\d/.test(part.replace(/^T/, ""))) at = (base ?? from).set({ hour: at.hour, minute: at.minute, second: at.second, millisecond: at.millisecond });
    if (!at.isValid && base) {
      const shortened = DateTime.fromISO(base.toISO()!.slice(0, base.toISO()!.length - part.length - 6) + part, zone);
      if (shortened.isValid) at = shortened;
    }
    return at.isValid ? at : fail();
  };
  /** Start, step and how many (null: no end), of an interval or a repeating one. */
  const interval = (parts: string[], times: number | null): number | null => {
    if (parts.length !== 2) return fail();
    const [a, b] = parts as [string, string];
    let first: DateTime;
    let step: Duration;
    if (/^P/i.test(a)) {
      step = duration(a);
      const end = time(b);
      // Recurrences of duration/end come before the end.
      first = times === null ? end.minus(step) : end.minus(step.mapUnits((x) => x * times));
      if (times === null) {
        // Unbounded towards the past: the latest start after now, if any, is the one ending at `end`.
        return first.toMillis() > now ? nextStart(first.minus(step.mapUnits((x) => x * Math.max(0, Math.floor((first.toMillis() - now) / step.toMillis())))), step, now, null) : null;
      }
    } else {
      first = time(a);
      step = /^P/i.test(b) ? duration(b) : Duration.fromMillis(time(b, first).toMillis() - first.toMillis());
      if (step.toMillis() <= 0) return fail();
    }
    return nextStart(first, step, now, times);
  };
  if (/^R\d*\//i.test(text)) {
    const [r, ...rest] = text.split("/");
    const times = r!.length > 1 ? Number(r!.slice(1)) : null;
    if (times === 0) return null;
    return interval(rest, times);
  }
  if (text.includes("/")) {
    const start = interval(text.split("/"), 1);
    return start;
  }
  if (/^P/i.test(text)) return from.plus(duration(text)).toMillis();
  const at = time(text).toMillis();
  return at > now ? at : null;
}

/** The first of `times` starts (first, first + step, …) after now; null when none is. */
function nextStart(first: DateTime, step: Duration, now: number, times: number | null): number | null {
  let k = Math.max(0, Math.floor((now - first.toMillis()) / step.toMillis()) - 1);
  for (let tries = 0; tries < 1000; tries++, k++) {
    if (times !== null && k >= times) return null;
    const at = first.plus(step.mapUnits((x) => x * k)).toMillis();
    if (at > now) return at;
  }
  return null;
}
