"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeBigIntToNumber = safeBigIntToNumber;
exports.safeParseBigInt = safeParseBigInt;
function safeBigIntToNumber(value) {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`BigInt value ${value} exceeds Number.MAX_SAFE_INTEGER and cannot be safely converted`);
    }
    return Number(value);
}
function safeParseBigInt(value) {
    if (typeof value === 'bigint')
        return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new RangeError(`safeParseBigInt: input must be finite, got ${value}`);
        }
        if (!Number.isInteger(value)) {
            throw new RangeError(`safeParseBigInt: input must be an integer, got ${value}`);
        }
        if (value > Number.MAX_SAFE_INTEGER || value < -Number.MAX_SAFE_INTEGER) {
            throw new RangeError(`safeParseBigInt: number ${value} exceeds MAX_SAFE_INTEGER`);
        }
        return BigInt(value);
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') {
            throw new RangeError('safeParseBigInt: empty string is not a valid BigInt');
        }
        if (!/^-?\d+$/.test(trimmed)) {
            throw new RangeError(`safeParseBigInt: "${trimmed}" is not a valid integer string`);
        }
        return BigInt(trimmed);
    }
    throw new TypeError(`safeParseBigInt: unsupported type ${typeof value}`);
}
