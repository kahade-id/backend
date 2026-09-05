"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizePhoneNumber = normalizePhoneNumber;
exports.hashPhoneNumber = hashPhoneNumber;
exports.encryptPii = encryptPii;
exports.decryptPii = decryptPii;
exports.decryptPiiSafe = decryptPiiSafe;
const crypto_util_1 = require("./crypto.util");
function normalizePhoneNumber(phone) {
    const cleaned = phone.replace(/[\s\-.]/g, '');
    if (cleaned.startsWith('0')) {
        return '+62' + cleaned.slice(1);
    }
    if (cleaned.startsWith('62') && !cleaned.startsWith('+62')) {
        return '+' + cleaned;
    }
    return cleaned;
}
function hashPhoneNumber(phone) {
    return (0, crypto_util_1.hmacSHA256)(phone);
}
async function encryptPii(value) {
    return (0, crypto_util_1.encryptAES)(value);
}
async function decryptPii(value) {
    return (0, crypto_util_1.decryptAES)(value);
}
async function decryptPiiSafe(value) {
    if (!value)
        return null;
    try {
        return await (0, crypto_util_1.decryptAES)(value);
    }
    catch {
        return value;
    }
}
