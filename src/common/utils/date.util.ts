import type { Dayjs } from 'dayjs';

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const dayjsBase = require('dayjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const utc = require('dayjs/plugin/utc');
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const timezone = require('dayjs/plugin/timezone');

dayjsBase.extend(utc);
dayjsBase.extend(timezone);

const dayjs: (date?: Date | string | number) => Dayjs = dayjsBase;

/** Jakarta / WIB timezone constant — single source of truth for the entire codebase. */
const JAKARTA_TZ = 'Asia/Jakarta';
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Wrap a date in a dayjs object set to the WIB (Asia/Jakarta) timezone. */
export function toWIB(date?: Date): Dayjs {
  return (dayjsBase(date).tz(JAKARTA_TZ)) as Dayjs;
}

/** Returns the start of the current day in WIB (00:00:00 WIB). */
export function startOfDayWIB(date?: Date): Date {
  return toWIB(date).startOf('day').toDate();
}

/** Returns the end of the current day in WIB (23:59:59.999 WIB). */
export function endOfDayWIB(date?: Date): Date {
  return toWIB(date).endOf('day').toDate();
}

/** Returns a calendar date string (YYYY-MM-DD) in WIB for filenames and reports. */
export function formatWIBDate(date: Date = new Date()): string {
  return toWIB(date).format('YYYY-MM-DD');
}

/**
 * Parses an API calendar date as midnight in WIB instead of relying on the
 * JavaScript UTC interpretation of `new Date('YYYY-MM-DD')`.
 */
export function parseWIBCalendarDate(value: string): Date | undefined {
  if (!CALENDAR_DATE_PATTERN.test(value)) return undefined;
  const parsed = dayjsBase.tz(`${value}T00:00:00`, JAKARTA_TZ);
  if (!parsed.isValid() || parsed.format('YYYY-MM-DD') !== value) return undefined;
  return parsed.toDate();
}

/** Parses an API date boundary, treating bare YYYY-MM-DD values as a WIB calendar day. */
export function parseDateBoundaryWIB(value: string, boundary: 'start' | 'end'): Date | undefined {
  const calendarDate = parseWIBCalendarDate(value);
  if (calendarDate) return boundary === 'start' ? startOfDayWIB(calendarDate) : endOfDayWIB(calendarDate);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function addMinutes(date: Date, minutes: number): Date {
  return dayjs(date).add(minutes, 'minute').toDate();
}

export function addHours(date: Date, hours: number): Date {
  return dayjs(date).add(hours, 'hour').toDate();
}

export function addDays(date: Date, days: number): Date {
  return dayjs(date).add(days, 'day').toDate();
}

export function isExpired(date: Date): boolean {
  return dayjs(date).isBefore(dayjs());
}

export function isFuture(date: Date): boolean {
  return dayjs(date).isAfter(dayjs());
}

export function startOfDay(date: Date = new Date()): Date {
  return dayjs(date).startOf('day').toDate();
}

export function endOfDay(date: Date = new Date()): Date {
  return dayjs(date).endOf('day').toDate();
}

export function toISOString(date: Date): string {
  return dayjs(date).toISOString();
}

export function diffInDays(date1: Date, date2: Date): number {
  return dayjs(date1).diff(dayjs(date2), 'day');
}

export function diffInHours(date1: Date, date2: Date): number {
  return dayjs(date1).diff(dayjs(date2), 'hour');
}

export function diffInMinutes(date1: Date, date2: Date): number {
  return dayjs(date1).diff(dayjs(date2), 'minute');
}
