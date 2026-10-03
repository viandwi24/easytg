/**
 * The widgets of `number` and `date` dialogue steps: plain calculations,
 * turned into buttons by the dialogue runner.
 */
import { EasyTGError } from './errors';
import type { DateInput } from './types';

// ---- dates -------------------------------------------------------------------
//
// A date answer is a calendar day, `YYYY-MM-DD`, with no time and no time zone.
// The calendar works on those days alone, with UTC arithmetic, so neither the
// server's time zone nor daylight saving time can shift a day. A time zone is
// only used to turn a moment (a `Date`, "now") into the day it is there.

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Midnight UTC of a calendar day. `setUTCFullYear`, unlike `Date.UTC`, keeps years below 100 as they are. */
function utcDay(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

const isoOf = (date: Date) => `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

/** Throws when `timeZone` isn't an IANA time zone Intl knows (e.g. `Asia/Jakarta`, `UTC`). */
export function checkTimeZone(timeZone: string | undefined): void {
  if (timeZone === undefined) return;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new EasyTGError(`Unknown time zone "${timeZone}": use an IANA name such as "Asia/Jakarta", "Europe/Berlin" or "UTC"`);
  }
}

/**
 * The day a moment falls on in a time zone, as `YYYY-MM-DD`. Default zone:
 * the server's. 2026-09-30T20:00Z is 2026-10-01 in Asia/Jakarta (UTC+7).
 */
export function dayInZone(moment: Date, timeZone?: string): string {
  if (Number.isNaN(moment.getTime())) throw new EasyTGError('Invalid Date');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', calendar: 'gregory', numberingSystem: 'latn' }).formatToParts(moment);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return `${pad(get('year'), 4)}-${pad(get('month'))}-${pad(get('day'))}`;
}

/** `YYYY-MM-DD` if `text` is a real calendar day (not 2026-02-30, not year 0000). */
export function parseIsoDate(text: string): string | undefined {
  const match = ISO.exec(text.trim());
  if (!match) return undefined;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  if (y < 1 || m < 1 || m > 12 || d < 1) return undefined;
  const date = utcDay(y, m, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? isoOf(date) : undefined;
}

/**
 * A step's `min` / `max` / `initial` as a day: a `YYYY-MM-DD` string as it is,
 * a `Date` (or a function's) as the day it is in `timeZone`. Throws on
 * anything else, so a typo never silently removes a limit.
 */
export function resolveDate(input: DateInput | undefined, timeZone: string | undefined, what: string): string | undefined {
  const value = typeof input === 'function' ? input() : input;
  if (value === undefined) return undefined;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new EasyTGError(`${what} is an Invalid Date`);
    return dayInZone(value, timeZone);
  }
  const day = typeof value === 'string' ? parseIsoDate(value) : undefined;
  if (!day) throw new EasyTGError(`${what} must be a Date or a "YYYY-MM-DD" day, got ${JSON.stringify(value)}`);
  return day;
}

/** `YYYY-MM` of a `YYYY-MM-DD`. */
export const monthOf = (iso: string) => iso.slice(0, 7);

/** `YYYY-MM-DD` strings compare like the days they are. */
export function inRange(iso: string, min?: string, max?: string) {
  return (!min || iso >= min) && (!max || iso <= max);
}

/** `YYYY-MM` plus `delta` months, in plain integers. */
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) + delta;
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}`;
}

export interface CalendarDay {
  day: number;
  iso: string;
  enabled: boolean;
}

export interface Calendar {
  /** "September 2026", in the user's language. */
  title: string;
  /** Months to go to, when they have days in range. */
  previous?: string;
  next?: string;
  /** Narrow weekday names, in order. */
  weekdays: string[];
  /** Weeks of the month; null for the cells before the 1st and after the last day. */
  weeks: (CalendarDay | null)[][];
}

export function calendar(month: string, options: { min?: string; max?: string; weekStartsOn?: 0 | 1; locale?: string }): Calendar {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const locale = safeLocale(options.locale);
  const first = utcDay(y, m, 1);
  const days = utcDay(y, m + 1, 0).getUTCDate();
  const start = options.weekStartsOn ?? 1;
  // Names of UTC days, formatted in UTC: the same in every server time zone.
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' });
  // 2023-01-01 was a Sunday.
  const weekdays = Array.from({ length: 7 }, (_, i) => weekdayFormat.format(utcDay(2023, 1, 1 + ((i + start) % 7))));

  const cells: (CalendarDay | null)[] = Array.from({ length: (first.getUTCDay() - start + 7) % 7 }, () => null);
  for (let day = 1; day <= days; day++) {
    const iso = `${month}-${pad(day)}`;
    cells.push({ day, iso, enabled: inRange(iso, options.min, options.max) });
  }
  while (cells.length % 7) cells.push(null);
  const weeks: (CalendarDay | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const previous = addMonths(month, -1);
  const next = addMonths(month, 1);
  return {
    title: new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first),
    previous: !options.min || monthOf(options.min) <= previous ? previous : undefined,
    next: !options.max || monthOf(options.max) >= next ? next : undefined,
    weekdays,
    weeks,
  };
}

/** The month a calendar opens on: `initial`, or today in `timeZone`, moved into `min`–`max`. */
export function startMonth(initial: string | undefined, min: string | undefined, max: string | undefined, timeZone?: string): string {
  let iso = initial ?? dayInZone(new Date(), timeZone);
  if (min && iso < min) iso = min;
  if (max && iso > max) iso = max;
  return monthOf(iso);
}

/** A month the calendar may show: well-formed and overlapping `min`–`max`. */
export function validMonth(month: string, min?: string, max?: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '0001-01') return false;
  return (!min || month >= monthOf(min)) && (!max || month <= monthOf(max));
}

function safeLocale(locale: string | undefined): string {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf(locale ?? 'en').length ? (locale ?? 'en') : 'en';
  } catch {
    return 'en';
  }
}

// ---- numbers -----------------------------------------------------------------

export interface NumberRange {
  min?: number;
  max?: number;
  step?: number;
}

export const numberInRange = (value: number, range: NumberRange) =>
  Number.isFinite(value) && (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);

/** Adds without float noise (0.1 + 0.2 → 0.3). */
export function addStep(value: number, delta: number): number {
  return Number((value + delta).toFixed(10));
}
