"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cryptoConfig = void 0;
const config_1 = require("@nestjs/config");
const PLACEHOLDER_PATTERNS = [
    /^changeme$/i, /^secret$/i, /^password$/i, /^your[_-]?secret/i,
    /^replace[_-]?me/i, /^default$/i, /^test$/i, /^example$/i,
    /^xxx+$/i, /^todo$/i, /^fixme$/i, /^placeholder$/i,
];
function isPlaceholder(value) {
    return PLACEHOLDER_PATTERNS.some((p) => p.test(value.trim()));
}
exports.cryptoConfig = (0, config_1.registerAs)('crypto', () => {
    const aesSecretKey = process.env.AES_SECRET_KEY || '';
    const aesKdfSalt = process.env.AES_KDF_SALT || '';
    const hmacSecretKey = process.env.HMAC_SECRET_KEY || '';
    const nodeEnv = process.env.NODE_ENV || 'development';
    if (['production', 'staging'].includes(nodeEnv)) {
        const missing = [
            !aesSecretKey && 'AES_SECRET_KEY',
            !aesKdfSalt && 'AES_KDF_SALT',
            !hmacSecretKey && 'HMAC_SECRET_KEY',
        ].filter(Boolean);
        if (missing.length > 0) {
            throw new Error(`Missing required crypto secrets in ${nodeEnv}: ${missing.join(', ')}`);
        }
        const placeholders = [
            isPlaceholder(aesSecretKey) && 'AES_SECRET_KEY',
            isPlaceholder(aesKdfSalt) && 'AES_KDF_SALT',
            isPlaceholder(hmacSecretKey) && 'HMAC_SECRET_KEY',
        ].filter(Boolean);
        if (placeholders.length > 0) {
            throw new Error(`Placeholder/default values detected for crypto secrets in ${nodeEnv}: ${placeholders.join(', ')}. Use real secrets.`);
        }
    }
    return {
        aesSecretKey,
        aesKdfSalt,
        hmacSecretKey,
        previousAesSecretKey: process.env.PREVIOUS_AES_SECRET_KEY || '',
        kycNikEncryptionKey: process.env.KYC_NIK_ENCRYPTION_KEY || '',
        kycKtpEncryptionKey: process.env.KYC_KTP_ENCRYPTION_KEY || '',
        kycSelfieEncryptionKey: process.env.KYC_SELFIE_ENCRYPTION_KEY || '',
        bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),
    };
});
