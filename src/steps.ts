/**
 * The widgets of `number` and `date` dialogue steps: plain calculations,
 * turned into buttons by the dialogue runner.
 */
import type { DateInput } from './types';

// ---- dates: `YYYY-MM-DD` strings, local calendar days ------------------------

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** A local date as `YYYY-MM-DD`. */
export function isoDate(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `YYYY-MM-DD` if `text` is a real calendar day (not 2026-02-30). */
export function parseIsoDate(text: string): string | undefined {
  const match = ISO.exec(text.trim());
  if (!match) return undefined;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? isoDate(date) : undefined;
}

export function resolveDate(input: DateInput | undefined): string | undefined {
  const value = typeof input === 'function' ? input() : input;
  if (value === undefined) return undefined;
  return value instanceof Date ? isoDate(value) : parseIsoDate(value);
}

/** `YYYY-MM` of a `YYYY-MM-DD`. */
export const monthOf = (iso: string) => iso.slice(0, 7);

export function inRange(iso: string, min?: string, max?: string) {
  return (!min || iso >= min) && (!max || iso <= max);
}

function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const date = new Date(y, m - 1 + delta, 1);
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}`;
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
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const start = options.weekStartsOn ?? 1;
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
  // 2023-01-01 was a Sunday.
  const weekdays = Array.from({ length: 7 }, (_, i) => weekdayFormat.format(new Date(2023, 0, 1 + ((i + start) % 7))));

  const cells: (CalendarDay | null)[] = Array.from({ length: (first.getDay() - start + 7) % 7 }, () => null);
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
    title: new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(first),
    previous: !options.min || monthOf(options.min) <= previous ? previous : undefined,
    next: !options.max || monthOf(options.max) >= next ? next : undefined,
    weekdays,
    weeks,
  };
}

/** The month a calendar opens on: `initial`, or today, moved into `min`–`max`. */
export function startMonth(initial: string | undefined, min?: string, max?: string): string {
  let iso = initial ?? isoDate(new Date());
  if (min && iso < min) iso = min;
  if (max && iso > max) iso = max;
  return monthOf(iso);
}

/** A month the calendar may show: well-formed and overlapping `min`–`max`. */
export function validMonth(month: string, min?: string, max?: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return false;
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
