"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.appConfig = void 0;
const config_1 = require("@nestjs/config");
function safePercent(raw, fallback) {
    if (raw === undefined || raw === '')
        return fallback;
    const value = parseFloat(raw);
    if (!Number.isFinite(value) || value < 0 || value > 100)
        return fallback;
    return value;
}
function parseFeeRate(envVar, fallback) {
    const raw = process.env[envVar];
    if (raw === undefined || raw === '')
        return fallback;
    const value = parseFloat(raw);
    if (isNaN(value) || value < 0 || value > 10) {
        throw new Error(`CONFIG ERROR: ${envVar}="${raw}" is not a valid fee rate. ` +
            `Expected a number between 0 and 10 (representing percentage, e.g. 1.5 = 1.50%).`);
    }
    return value;
}
function strictInt(envVar, fallback, min, max) {
    const raw = process.env[envVar];
    if (raw === undefined || raw.trim() === '')
        return fallback;
    const normalized = raw.trim();
    if (!/^[+-]?\d+$/.test(normalized)) {
        throw new Error(`CONFIG ERROR: ${envVar}="${raw}" must be an integer between ${min} and ${max}`);
    }
    const value = Number(normalized);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`CONFIG ERROR: ${envVar}="${raw}" must be an integer between ${min} and ${max}`);
    }
    return value;
}
function parseFeeRateBps(envVar, fallback) {
    const raw = process.env[envVar];
    if (raw === undefined || raw === '')
        return fallback;
    const value = parseInt(raw, 10);
    if (isNaN(value) || value < 0 || value > 1000) {
        throw new Error(`CONFIG ERROR: ${envVar}="${raw}" is not a valid fee rate in basis points. ` +
            `Expected an integer between 0 and 1000 (e.g. 150 = 1.50%).`);
    }
    return value;
}
exports.appConfig = (0, config_1.registerAs)('app', () => ({
    nodeEnv: process.env.NODE_ENV || 'development',
    port: strictInt('PORT', 3000, 1, 65535),
    shutdownTimeoutMs: strictInt('SHUTDOWN_TIMEOUT_MS', 30000, 1000, 120000),
    webhookRetryBatchSize: strictInt('WEBHOOK_RETRY_BATCH_SIZE', 25, 1, 100),
    appUrl: process.env.APP_URL || 'http://localhost:3000',
    deepLinkBaseUrl: process.env.DEEPLINK_BASE_URL || 'https://api.kahade.id/v1/deeplinks',
    publicWebBaseUrl: process.env.PUBLIC_WEB_BASE_URL || 'https://kahade.id',
    apiPrefix: process.env.API_PREFIX || 'v1',
    corsOrigins: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3001'],
    kahadeFeeRate: parseFeeRate('KAHADE_FEE_RATE', 2.5),
    kahadePlusFeeRate: parseFeeRate('KAHADE_PLUS_FEE_RATE', 0.5),
    kahadeFeeRateBps: parseFeeRateBps('KAHADE_FEE_RATE_BPS', Math.round(parseFeeRate('KAHADE_FEE_RATE', 2.5) * 100)),
    kahadePlusFeeRateBps: parseFeeRateBps('KAHADE_PLUS_FEE_RATE_BPS', Math.round(parseFeeRate('KAHADE_PLUS_FEE_RATE', 0.5) * 100)),
    orderMinValue: (() => { const v = parseInt(process.env.ORDER_MIN_VALUE || '10000', 10); if (isNaN(v) || v < 0)
        throw new Error(`CONFIG ERROR: ORDER_MIN_VALUE="${process.env.ORDER_MIN_VALUE}" is not a valid positive integer`); return v; })(),
    orderMaxValue: (() => {
        const v = parseInt(process.env.ORDER_MAX_VALUE || '1000000000', 10);
        if (isNaN(v) || v < 0)
            throw new Error(`CONFIG ERROR: ORDER_MAX_VALUE="${process.env.ORDER_MAX_VALUE}" is not a valid positive integer`);
        const minVal = parseInt(process.env.ORDER_MIN_VALUE || '10000', 10);
        if (!isNaN(minVal) && v < minVal)
            throw new Error(`CONFIG ERROR: ORDER_MAX_VALUE (${v}) must be >= ORDER_MIN_VALUE (${minVal})`);
        return v;
    })(),
    walletDailyTopupLimit: parseInt(process.env.WALLET_DAILY_TOPUP_LIMIT || '50000000', 10),
    walletDailyWithdrawLimit: parseInt(process.env.WALLET_DAILY_WITHDRAW_LIMIT || '50000000', 10),
    walletMinWithdraw: parseInt(process.env.WALLET_MIN_WITHDRAW || '50000', 10),
    walletPinPepper: (() => {
        const pepper = process.env.WALLET_PIN_PEPPER || '';
        const nodeEnv = process.env.NODE_ENV || 'development';
        if (['production', 'staging'].includes(nodeEnv)) {
            if (!pepper) {
                throw new Error(`WALLET_PIN_PEPPER is required in ${nodeEnv}`);
            }
            const placeholderPatterns = [
                /^changeme$/i, /^secret$/i, /^password$/i, /^your[_-]?secret/i,
                /^replace[_-]?me/i, /^default$/i, /^test$/i, /^example$/i,
                /^xxx+$/i, /^todo$/i, /^fixme$/i, /^placeholder$/i,
            ];
            if (placeholderPatterns.some((p) => p.test(pepper.trim()))) {
                throw new Error(`WALLET_PIN_PEPPER in ${nodeEnv} appears to be a placeholder value. Use a real secret.`);
            }
        }
        return pepper;
    })(),
    ratingWindowDays: parseInt(process.env.RATING_WINDOW_DAYS || '7', 10),
    accountLockMaxAttempts: parseInt(process.env.ACCOUNT_LOCK_MAX_ATTEMPTS || '5', 10),
    accountLockDurationMinutes: parseInt(process.env.ACCOUNT_LOCK_DURATION_MINUTES || '30', 10),
    accountLockMaxCycles: parseInt(process.env.ACCOUNT_LOCK_MAX_CYCLES || '5', 10),
    maxSessionsPerUser: parseInt(process.env.MAX_SESSIONS_PER_USER || '5', 10),
    redisAuthFailOpen: process.env.REDIS_AUTH_FAIL_OPEN === 'true',
    subscriptionMonthlyPrice: parseInt(process.env.SUBSCRIPTION_MONTHLY_PRICE || '29000', 10),
    subscriptionAnnualPrice: parseInt(process.env.SUBSCRIPTION_ANNUAL_PRICE || '299000', 10),
    subscriptionMonthlyPriceSen: parseInt(process.env.SUBSCRIPTION_MONTHLY_PRICE_SEN || String(parseInt(process.env.SUBSCRIPTION_MONTHLY_PRICE || '29000', 10) * 100), 10),
    subscriptionAnnualPriceSen: parseInt(process.env.SUBSCRIPTION_ANNUAL_PRICE_SEN || String(parseInt(process.env.SUBSCRIPTION_ANNUAL_PRICE || '299000', 10) * 100), 10),
    exportMaxDateRangeDays: parseInt(process.env.EXPORT_MAX_DATE_RANGE_DAYS || '90', 10),
    orderCreateRateLimit: (() => {
        const v = parseInt(process.env.ORDER_CREATE_RATE_LIMIT || '5', 10);
        return Number.isInteger(v) && v > 0 && v <= 1000 ? v : 5;
    })(),
    orderCreateRateWindowSec: (() => {
        const v = parseInt(process.env.ORDER_CREATE_RATE_WINDOW_SEC || '60', 10);
        return Number.isInteger(v) && v > 0 && v <= 3600 ? v : 60;
    })(),
    otpExpiresMinutes: parseInt(process.env.OTP_EXPIRES_MINUTES || '5', 10),
    otpMaxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS || '5', 10),
    otpLength: parseInt(process.env.OTP_LENGTH || '6', 10),
    throttleGlobalTtlMs: parseInt(process.env.THROTTLE_GLOBAL_TTL_MS || '60000', 10),
    throttleGlobalLimit: parseInt(process.env.THROTTLE_GLOBAL_LIMIT || '100', 10),
    idempotencyTtlSeconds: parseInt(process.env.IDEMPOTENCY_TTL_SECONDS || '86400', 10),
    idempotencyFailOpen: process.env.IDEMPOTENCY_FAIL_OPEN === 'true',
    topupExpiryHours: parseInt(process.env.TOPUP_EXPIRY_HOURS || '24', 10),
    paymentFeeVaBca: parseInt(process.env.PAYMENT_FEE_VA_BCA || '4000', 10),
    paymentFeeVaBni: parseInt(process.env.PAYMENT_FEE_VA_BNI || '4000', 10),
    paymentFeeVaBri: parseInt(process.env.PAYMENT_FEE_VA_BRI || '4000', 10),
    paymentFeeVaMandiri: parseInt(process.env.PAYMENT_FEE_VA_MANDIRI || '4000', 10),
    paymentFeeVaPermata: parseInt(process.env.PAYMENT_FEE_VA_PERMATA || '4000', 10),
    paymentFeeVaCimb: parseInt(process.env.PAYMENT_FEE_VA_CIMB || '4000', 10),
    paymentFeeQrisPercent: safePercent(process.env.PAYMENT_FEE_QRIS_PERCENT, 0.7),
    paymentFeeGopayPercent: safePercent(process.env.PAYMENT_FEE_GOPAY_PERCENT, 2.0),
    paymentFeeShopeePayPercent: safePercent(process.env.PAYMENT_FEE_SHOPEEPAY_PERCENT, 2.0),
    paymentFeeCreditCardPercent: safePercent(process.env.PAYMENT_FEE_CREDIT_CARD_PERCENT, 2.9),
    paymentFeeCreditCardFlat: parseInt(process.env.PAYMENT_FEE_CREDIT_CARD_FLAT || '2000', 10),
    paymentFeeCstoreFlat: parseInt(process.env.PAYMENT_FEE_CSTORE_FLAT || '5000', 10),
    paymentFeeAkulakuPercent: safePercent(process.env.PAYMENT_FEE_AKULAKU_PERCENT, 3.0),
    paymentFeeKredivoPercent: safePercent(process.env.PAYMENT_FEE_KREDIVO_PERCENT, 3.0),
    uploadMaxAvatarMb: parseInt(process.env.UPLOAD_MAX_AVATAR_MB || '2', 10),
    uploadMaxChatMb: parseInt(process.env.UPLOAD_MAX_CHAT_MB || '10', 10),
    uploadMaxKycMb: parseInt(process.env.UPLOAD_MAX_KYC_MB || '5', 10),
    uploadMaxEvidenceMb: parseInt(process.env.UPLOAD_MAX_EVIDENCE_MB || '5', 10),
    referralRewardRateBps: parseInt(process.env.REFERRAL_REWARD_RATE_BPS || '1000', 10),
    maxReferralsPerCode: parseInt(process.env.MAX_REFERRALS_PER_CODE || '100', 10),
    feeSavingsLimit: parseInt(process.env.FEE_SAVINGS_LIMIT || '5000000', 10),
    retentionReadNotificationDays: Math.max(7, parseInt(process.env.RETENTION_READ_NOTIFICATION_DAYS || '30', 10)),
    retentionUnreadNotificationDays: Math.max(14, parseInt(process.env.RETENTION_UNREAD_NOTIFICATION_DAYS || '90', 10)),
    retentionExpiredOtpDays: Math.max(7, parseInt(process.env.RETENTION_EXPIRED_OTP_DAYS || '90', 10)),
    retentionWebhookLogDays: Math.max(7, parseInt(process.env.RETENTION_WEBHOOK_LOG_DAYS || '90', 10)),
    retentionAnonymizeDays: Math.max(7, parseInt(process.env.RETENTION_ANONYMIZE_DAYS || '30', 10)),
    orphanUploadThresholdHours: strictInt('ORPHAN_UPLOAD_THRESHOLD_HOURS', 24, 4, 24 * 365),
    orphanCleanupEnabled: process.env.ORPHAN_CLEANUP_ENABLED === 'true',
    emailAuthEnabled: process.env.EMAIL_AUTH_ENABLED === 'true',
    skipBankVerification: process.env.NODE_ENV === 'production' ? false : process.env.SKIP_BANK_VERIFICATION === 'true',
    iosLatestVersion: process.env.IOS_LATEST_VERSION || '1.0.0',
    iosMinimumVersion: process.env.IOS_MINIMUM_VERSION || '1.0.0',
    iosStoreUrl: process.env.IOS_STORE_URL || 'https://apps.apple.com/app/kahade',
    androidLatestVersion: process.env.ANDROID_LATEST_VERSION || '1.0.0',
    androidMinimumVersion: process.env.ANDROID_MINIMUM_VERSION || '1.0.0',
    androidStoreUrl: process.env.ANDROID_STORE_URL || 'https://play.google.com/store/apps/details?id=id.kahade.frontend',
    updateCheckIntervalMs: parseInt(process.env.UPDATE_CHECK_INTERVAL_MS || '21600000', 10),
}));
