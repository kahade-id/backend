"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateUserId = generateUserId;
exports.generateOrderId = generateOrderId;
exports.generateKycId = generateKycId;
exports.generateDisputeId = generateDisputeId;
exports.generateWalletTxId = generateWalletTxId;
exports.generatePaymentTxId = generatePaymentTxId;
exports.generateNotifId = generateNotifId;
exports.generateAdminId = generateAdminId;
exports.generateReferralCode = generateReferralCode;
exports.generateOrderLinkId = generateOrderLinkId;
exports.generateOrderLinkToken = generateOrderLinkToken;
exports.generateCampaignId = generateCampaignId;
const crypto_1 = require("crypto");
const nanoid_1 = require("nanoid");
const date_util_1 = require("./date.util");
const ALPHANUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const safeNanoId = (0, nanoid_1.customAlphabet)(ALPHANUM, 16);
function secureRandom(chars, length) {
    const limit = 256 - (256 % chars.length);
    let result = '';
    const maxIterations = length * 20;
    let iterations = 0;
    while (result.length < length) {
        if (++iterations > maxIterations) {
            throw new Error(`secureRandom exceeded max iterations (${maxIterations})`);
        }
        const buf = (0, crypto_1.randomBytes)(Math.max(1, (length - result.length) * 2));
        for (let i = 0; i < buf.length && result.length < length; i++) {
            if (buf[i] < limit)
                result += chars.charAt(buf[i] % chars.length);
        }
    }
    return result;
}
function generateUserId() {
    return 'USR-' + secureRandom('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 8);
}
function jakartaDateStr() {
    return (0, date_util_1.toWIB)().format('YYYYMMDD');
}
function cryptoSuffix(len = 4) {
    return secureRandom('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', len);
}
function generateOrderId(serial) {
    return `ORD-${jakartaDateStr()}-${serial.toString().padStart(6, '0')}-${cryptoSuffix()}`;
}
function generateKycId(serial) {
    return `KYC-${jakartaDateStr()}-${serial.toString().padStart(6, '0')}-${cryptoSuffix()}`;
}
function generateDisputeId(serial) {
    return `DSP-${jakartaDateStr()}-${serial.toString().padStart(6, '0')}-${cryptoSuffix()}`;
}
function generateWalletTxId(serial) {
    return `WLT-${jakartaDateStr()}-${serial.toString().padStart(6, '0')}-${cryptoSuffix()}`;
}
function generatePaymentTxId(serial) {
    return `PAY-${jakartaDateStr()}-${serial.toString().padStart(6, '0')}-${cryptoSuffix()}`;
}
function generateNotifId() {
    return `NTF-${safeNanoId()}`;
}
function generateAdminId() {
    return 'ADMIN-' + secureRandom('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 5);
}
function generateReferralCode() {
    return 'KH' + secureRandom('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 8);
}
function generateOrderLinkId(serial) {
    return `OLK-${jakartaDateStr()}-${serial.toString().padStart(6, '0')}-${cryptoSuffix()}`;
}
function generateOrderLinkToken() {
    return secureRandom('abcdefghijklmnopqrstuvwxyz0123456789', 24);
}
function generateCampaignId(serial) {
    return `CMP-${jakartaDateStr()}-${serial.toString().padStart(6, '0')}-${cryptoSuffix()}`;
}
