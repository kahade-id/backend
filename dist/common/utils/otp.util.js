"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateOtp = generateOtp;
exports.generateBackupCodes = generateBackupCodes;
exports.hashOtp = hashOtp;
exports.verifyOtp = verifyOtp;
const crypto_1 = require("crypto");
const bcrypt = __importStar(require("bcrypt"));
const crypto_util_1 = require("./crypto.util");
function uniformByte(max) {
    const limit = 256 - (256 % max);
    let b;
    do {
        b = (0, crypto_1.randomBytes)(1)[0];
    } while (b >= limit);
    return b % max;
}
function generateOtp(length = 6) {
    const digits = '0123456789';
    let otp = '';
    for (let i = 0; i < length; i++)
        otp += digits.charAt(uniformByte(digits.length));
    return otp;
}
function generateBackupCodes(count = 10, length = 16) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const codes = [];
    for (let i = 0; i < count; i++) {
        let code = '';
        for (let j = 0; j < length; j++)
            code += chars.charAt(uniformByte(chars.length));
        codes.push(code);
    }
    return codes;
}
async function hashOtp(otp) {
    return bcrypt.hash(otp, (0, crypto_util_1.getBcryptRounds)());
}
async function verifyOtp(otp, hash) {
    return bcrypt.compare(otp, hash);
}
