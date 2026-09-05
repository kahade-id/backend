"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.r2Config = void 0;
const config_1 = require("@nestjs/config");
function requiredR2(key) {
    const val = process.env[key];
    if (!val || val.trim() === '') {
        throw new Error(`FATAL: ${key} is required. Cannot start without R2 storage configuration.`);
    }
    return val;
}
exports.r2Config = (0, config_1.registerAs)('r2', () => {
    const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? '';
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? '';
    const accountId = process.env.R2_ACCOUNT_ID ?? '';
    const nodeEnv = process.env.NODE_ENV || 'development';
    if (nodeEnv === 'production' || nodeEnv === 'staging') {
        if (!accessKeyId || !secretAccessKey) {
            throw new Error('R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required in production/staging');
        }
        if (!accountId) {
            throw new Error('R2_ACCOUNT_ID is required in production/staging');
        }
    }
    const endpointUrl = accountId
        ? `https://${accountId}.r2.cloudflarestorage.com`
        : undefined;
    return {
        accountId,
        accessKeyId,
        secretAccessKey,
        bucketPublic: requiredR2('R2_BUCKET_PUBLIC'),
        bucketPrivate: requiredR2('R2_BUCKET_PRIVATE'),
        publicUrl: requiredR2('R2_PUBLIC_URL'),
        presignExpires: parseInt(process.env.R2_PRESIGN_EXPIRES || '900', 10),
        endpointUrl,
    };
});
