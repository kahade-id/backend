"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toWIB = toWIB;
exports.startOfDayWIB = startOfDayWIB;
exports.endOfDayWIB = endOfDayWIB;
exports.formatWIBDate = formatWIBDate;
exports.parseWIBCalendarDate = parseWIBCalendarDate;
exports.parseDateBoundaryWIB = parseDateBoundaryWIB;
exports.addMinutes = addMinutes;
exports.addHours = addHours;
exports.addDays = addDays;
exports.isExpired = isExpired;
exports.isFuture = isFuture;
exports.startOfDay = startOfDay;
exports.endOfDay = endOfDay;
exports.toISOString = toISOString;
exports.diffInDays = diffInDays;
exports.diffInHours = diffInHours;
exports.diffInMinutes = diffInMinutes;
const dayjsBase = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjsBase.extend(utc);
dayjsBase.extend(timezone);
const dayjs = dayjsBase;
const JAKARTA_TZ = 'Asia/Jakarta';
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
function toWIB(date) {
    return (dayjsBase(date).tz(JAKARTA_TZ));
}
function startOfDayWIB(date) {
    return toWIB(date).startOf('day').toDate();
}
function endOfDayWIB(date) {
    return toWIB(date).endOf('day').toDate();
}
function formatWIBDate(date = new Date()) {
    return toWIB(date).format('YYYY-MM-DD');
}
function parseWIBCalendarDate(value) {
    if (!CALENDAR_DATE_PATTERN.test(value))
        return undefined;
    const parsed = dayjsBase.tz(`${value}T00:00:00`, JAKARTA_TZ);
    if (!parsed.isValid() || parsed.format('YYYY-MM-DD') !== value)
        return undefined;
    return parsed.toDate();
}
function parseDateBoundaryWIB(value, boundary) {
    const calendarDate = parseWIBCalendarDate(value);
    if (calendarDate)
        return boundary === 'start' ? startOfDayWIB(calendarDate) : endOfDayWIB(calendarDate);
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
function addMinutes(date, minutes) {
    return dayjs(date).add(minutes, 'minute').toDate();
}
function addHours(date, hours) {
    return dayjs(date).add(hours, 'hour').toDate();
}
function addDays(date, days) {
    return dayjs(date).add(days, 'day').toDate();
}
function isExpired(date) {
    return dayjs(date).isBefore(dayjs());
}
function isFuture(date) {
    return dayjs(date).isAfter(dayjs());
}
function startOfDay(date = new Date()) {
    return dayjs(date).startOf('day').toDate();
}
function endOfDay(date = new Date()) {
    return dayjs(date).endOf('day').toDate();
}
function toISOString(date) {
    return dayjs(date).toISOString();
}
function diffInDays(date1, date2) {
    return dayjs(date1).diff(dayjs(date2), 'day');
}
function diffInHours(date1, date2) {
    return dayjs(date1).diff(dayjs(date2), 'hour');
}
function diffInMinutes(date1, date2) {
    return dayjs(date1).diff(dayjs(date2), 'minute');
}
