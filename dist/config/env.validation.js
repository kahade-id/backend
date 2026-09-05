"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEnv = validateEnv;
function required(env, key, errors) {
    const val = env[key];
    if (!val || val.trim() === '') {
        errors.push({ key, message: `${key} is required but missing or empty` });
        return undefined;
    }
    return val;
}
function optionalInt(env, key, defaultValue, min, max, errors) {
    const raw = env[key];
    if (!raw)
        return defaultValue;
    const normalized = raw.trim();
    const n = Number(normalized);
    if (!/^[+-]?\d+$/.test(normalized) || !Number.isSafeInteger(n) || n < min || n > max) {
        errors.push({ key, message: `${key}="${raw}" must be an integer between ${min} and ${max}` });
        return defaultValue;
    }
    return n;
}
function optionalFloat(env, key, defaultValue, min, max, errors) {
    const raw = env[key];
    if (!raw)
        return defaultValue;
    const normalized = raw.trim();
    const n = Number(normalized);
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized) || !Number.isFinite(n) || n < min || n > max) {
        errors.push({ key, message: `${key}="${raw}" must be a number between ${min} and ${max}` });
        return defaultValue;
    }
    return n;
}
function optionalUrl(env, key, errors) {
    const raw = env[key];
    if (!raw)
        return undefined;
    try {
        new URL(raw);
        return raw;
    }
    catch {
        errors.push({ key, message: `${key}="${raw}" must be a valid URL (including protocol)` });
        return undefined;
    }
}
function optionalEnum(env, key, allowed, defaultValue, errors) {
    const raw = env[key];
    if (!raw)
        return defaultValue;
    if (!allowed.includes(raw)) {
        errors.push({ key, message: `${key}="${raw}" must be one of: ${allowed.join(', ')}` });
        return defaultValue;
    }
    return raw;
}
function validateEnv(env) {
    const errors = [];
    const validatedNodeEnv = optionalEnum(env, 'NODE_ENV', ['development', 'test', 'staging', 'production'], 'development', errors);
    const nodeEnv = validatedNodeEnv;
    const isProdLike = ['production', 'staging'].includes(validatedNodeEnv);
    optionalInt(env, 'PORT', 3000, 1, 65535, errors);
    optionalInt(env, 'SHUTDOWN_TIMEOUT_MS', 30000, 1000, 120000, errors);
    optionalInt(env, 'WEBHOOK_RETRY_BATCH_SIZE', 25, 1, 100, errors);
    optionalInt(env, 'ORPHAN_UPLOAD_THRESHOLD_HOURS', 24, 4, 24 * 365, errors);
    required(env, 'DATABASE_URL', errors);
    const redisUrl = required(env, 'REDIS_URL', errors);
    const bullRedisUrl = required(env, 'BULL_REDIS_URL', errors);
    for (const [key, value] of [['REDIS_URL', redisUrl], ['BULL_REDIS_URL', bullRedisUrl]]) {
        if (value) {
            try {
                const parsed = new URL(value);
                if (!['redis:', 'rediss:'].includes(parsed.protocol))
                    throw new Error('unsupported protocol');
            }
            catch {
                errors.push({ key, message: `${key} must be a valid redis:// or rediss:// URL` });
            }
        }
    }
    required(env, 'JWT_SECRET', errors);
    required(env, 'JWT_REFRESH_SECRET', errors);
    required(env, 'JWT_ADMIN_SECRET', errors);
    required(env, 'JWT_ADMIN_REFRESH_SECRET', errors);
    required(env, 'JWT_TEMP_SECRET', errors);
    const jwtSecrets = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'JWT_ADMIN_SECRET', 'JWT_ADMIN_REFRESH_SECRET', 'JWT_TEMP_SECRET'];
    for (const key of jwtSecrets) {
        const val = env[key];
        if (val && val.length < 32) {
            errors.push({ key, message: `${key} must be at least 32 characters for HS256/HS512 security` });
        }
    }
    optionalInt(env, 'WS_AUTH_TIMEOUT_MS', 10000, 1000, 30000, errors);
    const aesKey = required(env, 'AES_SECRET_KEY', errors);
    if (aesKey && aesKey.length < 64) {
        errors.push({ key: 'AES_SECRET_KEY', message: 'AES_SECRET_KEY must be at least 64 hex characters for AES-256 key derivation' });
    }
    if (aesKey && !/^[0-9a-fA-F]+$/.test(aesKey)) {
        errors.push({ key: 'AES_SECRET_KEY', message: 'AES_SECRET_KEY must contain only hexadecimal characters' });
    }
    const hmacKey = required(env, 'HMAC_SECRET_KEY', errors);
    if (hmacKey && hmacKey.length < 64) {
        errors.push({ key: 'HMAC_SECRET_KEY', message: 'HMAC_SECRET_KEY must be at least 64 hex characters' });
    }
    if (hmacKey && !/^[0-9a-fA-F]+$/.test(hmacKey)) {
        errors.push({ key: 'HMAC_SECRET_KEY', message: 'HMAC_SECRET_KEY must contain only hexadecimal characters' });
    }
    const kdfSalt = required(env, 'AES_KDF_SALT', errors);
    if (kdfSalt && kdfSalt.length < 32) {
        errors.push({ key: 'AES_KDF_SALT', message: 'AES_KDF_SALT must be at least 32 characters' });
    }
    optionalUrl(env, 'MIDTRANS_API_URL', errors);
    optionalUrl(env, 'MIDTRANS_IRIS_URL', errors);
    const envNodeEnv = env['NODE_ENV'] || 'development';
    if (['production', 'staging'].includes(envNodeEnv)) {
        required(env, 'MIDTRANS_ALLOWED_CIDRS', errors);
    }
    required(env, 'R2_ACCESS_KEY_ID', errors);
    required(env, 'R2_SECRET_ACCESS_KEY', errors);
    required(env, 'R2_ACCOUNT_ID', errors);
    required(env, 'R2_BUCKET_PUBLIC', errors);
    required(env, 'R2_BUCKET_PRIVATE', errors);
    const r2PublicUrl = optionalUrl(env, 'R2_PUBLIC_URL', errors);
    if (isProdLike && !r2PublicUrl) {
        required(env, 'R2_PUBLIC_URL', errors);
    }
    required(env, 'SMTP_HOST', errors);
    optionalInt(env, 'SMTP_PORT', 587, 1, 65535, errors);
    required(env, 'SMTP_USER', errors);
    required(env, 'SMTP_PASS', errors);
    required(env, 'SMTP_FROM', errors);
    const pinPepper = required(env, 'WALLET_PIN_PEPPER', errors);
    if (pinPepper && pinPepper.length < 32) {
        errors.push({ key: 'WALLET_PIN_PEPPER', message: 'WALLET_PIN_PEPPER must be at least 32 characters for PIN hardening' });
    }
    optionalFloat(env, 'KAHADE_FEE_RATE', 2.5, 0, 10, errors);
    optionalFloat(env, 'KAHADE_PLUS_FEE_RATE', 0.5, 0, 10, errors);
    optionalInt(env, 'KAHADE_FEE_RATE_BPS', 250, 0, 1000, errors);
    optionalInt(env, 'KAHADE_PLUS_FEE_RATE_BPS', 50, 0, 1000, errors);
    if (env.KAHADE_FEE_RATE && env.KAHADE_FEE_RATE_BPS) {
        const rateFromPercent = Math.round(parseFloat(env.KAHADE_FEE_RATE) * 100);
        const bps = parseInt(env.KAHADE_FEE_RATE_BPS, 10);
        if (rateFromPercent !== bps) {
            errors.push({ key: 'KAHADE_FEE_RATE_BPS', message: `KAHADE_FEE_RATE (${env.KAHADE_FEE_RATE}% = ${rateFromPercent} bps) conflicts with KAHADE_FEE_RATE_BPS (${bps}). Set only one or ensure they match.` });
        }
    }
    if (env.KAHADE_PLUS_FEE_RATE && env.KAHADE_PLUS_FEE_RATE_BPS) {
        const rateFromPercent = Math.round(parseFloat(env.KAHADE_PLUS_FEE_RATE) * 100);
        const bps = parseInt(env.KAHADE_PLUS_FEE_RATE_BPS, 10);
        if (rateFromPercent !== bps) {
            errors.push({ key: 'KAHADE_PLUS_FEE_RATE_BPS', message: `KAHADE_PLUS_FEE_RATE (${env.KAHADE_PLUS_FEE_RATE}% = ${rateFromPercent} bps) conflicts with KAHADE_PLUS_FEE_RATE_BPS (${bps}). Set only one or ensure they match.` });
        }
    }
    optionalInt(env, 'ORDER_MIN_VALUE', 10000, 1000, 1_000_000_000, errors);
    optionalInt(env, 'ORDER_MAX_VALUE', 1_000_000_000, 10000, 10_000_000_000, errors);
    optionalInt(env, 'WALLET_DAILY_TOPUP_LIMIT', 50_000_000, 0, 1_000_000_000, errors);
    optionalInt(env, 'WALLET_DAILY_WITHDRAW_LIMIT', 50_000_000, 0, 1_000_000_000, errors);
    optionalInt(env, 'WALLET_MIN_WITHDRAW', 50000, 0, 10_000_000, errors);
    optionalInt(env, 'OTP_EXPIRES_MINUTES', 5, 1, 60, errors);
    optionalInt(env, 'OTP_MAX_ATTEMPTS', 5, 1, 20, errors);
    optionalInt(env, 'OTP_LENGTH', 6, 4, 8, errors);
    optionalEnum(env, 'OTP_PROVIDER', ['mock', 'fonnte', 'twilio'], 'mock', errors);
    const otpProvider = (env['OTP_PROVIDER'] || 'mock').toLowerCase();
    const envNodeEnvForOtp = env['NODE_ENV'] || 'development';
    if (envNodeEnvForOtp === 'production' && otpProvider === 'mock') {
        errors.push({
            key: 'OTP_PROVIDER',
            message: 'OTP_PROVIDER must be set to a real provider (e.g. "fonnte" or "twilio") in production. Refusing to start with the mock gateway in production — users would never receive OTPs.',
        });
    }
    if (otpProvider === 'fonnte' && !env['FONNTE_API_TOKEN']) {
        errors.push({
            key: 'FONNTE_API_TOKEN',
            message: 'FONNTE_API_TOKEN is required when OTP_PROVIDER=fonnte.',
        });
    }
    if (otpProvider === 'twilio') {
        if (!env['TWILIO_ACCOUNT_SID']) {
            errors.push({ key: 'TWILIO_ACCOUNT_SID', message: 'TWILIO_ACCOUNT_SID is required when OTP_PROVIDER=twilio.' });
        }
        if (!env['TWILIO_AUTH_TOKEN']) {
            errors.push({ key: 'TWILIO_AUTH_TOKEN', message: 'TWILIO_AUTH_TOKEN is required when OTP_PROVIDER=twilio.' });
        }
        if (!env['TWILIO_SMS_FROM'] && !env['TWILIO_WHATSAPP_FROM']) {
            errors.push({ key: 'TWILIO_SMS_FROM', message: 'At least one of TWILIO_SMS_FROM or TWILIO_WHATSAPP_FROM must be set when OTP_PROVIDER=twilio.' });
        }
    }
    if (envNodeEnvForOtp === 'production' &&
        ['true', '1', 'yes'].includes((env['OTP_DEBUG_RETURN_CODE'] || '').toLowerCase())) {
        errors.push({
            key: 'OTP_DEBUG_RETURN_CODE',
            message: 'OTP_DEBUG_RETURN_CODE is not allowed in production — it would expose OTP codes in API responses. Disable it.',
        });
    }
    optionalInt(env, 'ACCOUNT_LOCK_MAX_ATTEMPTS', 5, 1, 20, errors);
    optionalInt(env, 'ACCOUNT_LOCK_DURATION_MINUTES', 30, 1, 1440, errors);
    optionalInt(env, 'THROTTLE_GLOBAL_TTL_MS', 60000, 1000, 3_600_000, errors);
    optionalInt(env, 'THROTTLE_GLOBAL_LIMIT', 100, 1, 10000, errors);
    optionalInt(env, 'TOPUP_EXPIRY_HOURS', 24, 1, 168, errors);
    optionalInt(env, 'EXPORT_MAX_DATE_RANGE_DAYS', 90, 7, 365, errors);
    optionalInt(env, 'UPLOAD_MAX_AVATAR_MB', 2, 1, 10, errors);
    optionalInt(env, 'UPLOAD_MAX_CHAT_MB', 10, 1, 50, errors);
    optionalInt(env, 'UPLOAD_MAX_KYC_MB', 5, 1, 50, errors);
    optionalInt(env, 'UPLOAD_MAX_EVIDENCE_MB', 5, 1, 50, errors);
    optionalInt(env, 'REFERRAL_REWARD_RATE_BPS', 1000, 0, 5000, errors);
    optionalInt(env, 'MAX_REFERRALS_PER_CODE', 100, 1, 100_000, errors);
    optionalInt(env, 'FEE_SAVINGS_LIMIT', 5_000_000, 0, 100_000_000_000, errors);
    for (const key of ['REDIS_AUTH_FAIL_OPEN', 'IDEMPOTENCY_FAIL_OPEN']) {
        const raw = env[key];
        if (raw !== undefined && !/^(true|false)$/i.test(raw.trim())) {
            errors.push({ key, message: `${key} must be exactly "true" or "false" when provided` });
        }
        if (isProdLike && raw && raw.trim().toLowerCase() === 'true') {
            errors.push({ key, message: `${key} must be false in ${nodeEnv}; fail-open mode is not allowed for auth or escrow mutations` });
        }
    }
    const fcmProjectId = env['FCM_PROJECT_ID'];
    const fcmClientEmail = env['FCM_CLIENT_EMAIL'];
    const fcmPrivateKey = env['FCM_PRIVATE_KEY'];
    const hasSomeFcm = !!(fcmProjectId || fcmClientEmail || fcmPrivateKey);
    const hasAllFcm = !!(fcmProjectId && fcmClientEmail && fcmPrivateKey);
    if (hasSomeFcm && !hasAllFcm) {
        errors.push({
            key: 'FCM_*',
            message: 'Partial FCM config detected — set all of FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY or none',
        });
    }
    optionalUrl(env, 'SENTRY_DSN', errors);
    optionalFloat(env, 'SENTRY_TRACES_SAMPLE_RATE', 0.1, 0, 1, errors);
    const corsNodeEnv = env['NODE_ENV'] || 'development';
    const corsOrigins = env['CORS_ORIGINS'];
    const corsOriginList = corsOrigins?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? [];
    if (!corsOrigins && ['production', 'staging'].includes(corsNodeEnv)) {
        errors.push({ key: 'CORS_ORIGINS', message: `CORS_ORIGINS is required in ${corsNodeEnv}` });
    }
    if (['production', 'staging'].includes(corsNodeEnv) && corsOrigins && corsOriginList.length === 0) {
        errors.push({ key: 'CORS_ORIGINS', message: 'CORS_ORIGINS must contain at least one origin' });
    }
    if (['production', 'staging'].includes(corsNodeEnv) && corsOriginList.some((origin) => origin === '*' || origin.includes('*'))) {
        errors.push({ key: 'CORS_ORIGINS', message: 'CORS_ORIGINS must not contain wildcard origins in production/staging' });
    }
    if (corsNodeEnv === 'production') {
        const insecureOrigins = corsOriginList.filter((origin) => {
            try {
                return new URL(origin).protocol !== 'https:';
            }
            catch {
                return true;
            }
        });
        if (insecureOrigins.length > 0) {
            errors.push({ key: 'CORS_ORIGINS', message: `Production CORS origins must use valid HTTPS URLs: ${insecureOrigins.join(', ')}` });
        }
        const localOrigins = corsOriginList.filter((origin) => {
            try {
                return ['localhost', '127.0.0.1'].includes(new URL(origin).hostname.toLowerCase());
            }
            catch {
                return false;
            }
        });
        if (localOrigins.length > 0) {
            errors.push({ key: 'CORS_ORIGINS', message: `Production CORS origins must not reference localhost: ${localOrigins.join(', ')}` });
        }
    }
    if (errors.length > 0) {
        const lines = errors.map(({ key, message }) => `  • ${key}: ${message}`);
        throw new Error(`Environment validation failed — fix the following variables before starting:\n${lines.join('\n')}`);
    }
    return env;
}
