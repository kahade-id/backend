"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toSen = toSen;
exports.toIdr = toIdr;
exports.formatIdr = formatIdr;
exports.formatSen = formatSen;
function toSen(idr) {
    if (!Number.isFinite(idr)) {
        throw new RangeError(`toSen: input must be a finite number, got ${idr}`);
    }
    if (idr < 0) {
        throw new RangeError(`toSen: input must be non-negative, got ${idr}`);
    }
    if (idr > Number.MAX_SAFE_INTEGER / 100) {
        throw new RangeError(`toSen: input ${idr} exceeds safe integer range when converted to sen`);
    }
    const [integer, decimal = ''] = idr.toFixed(2).split('.');
    return BigInt(integer) * 100n + BigInt(decimal.slice(0, 2).padEnd(2, '0'));
}
function toIdr(sen) {
    if (sen > BigInt(Number.MAX_SAFE_INTEGER) || sen < BigInt(-Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`toIdr: input ${sen} exceeds Number.MAX_SAFE_INTEGER`);
    }
    const whole = Number(sen / 100n);
    const frac = Number(sen % 100n);
    return whole + frac / 100;
}
function formatIdr(amount) {
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    }).format(amount);
}
function formatSen(sen) {
    return formatIdr(toIdr(sen));
}
