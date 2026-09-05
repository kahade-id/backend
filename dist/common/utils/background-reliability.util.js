"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withTimeout = withTimeout;
exports.startLockRenewal = startLockRenewal;
exports.safeErrorMessage = safeErrorMessage;
exports.parseStrictInteger = parseStrictInteger;
exports.parseStrictBoolean = parseStrictBoolean;
async function withTimeout(operation, timeoutMs, label) {
    const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5_000;
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${boundedTimeoutMs}ms`)), boundedTimeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function startLockRenewal(redis, key, token, ttlSeconds, logger, onLost) {
    const safeTtl = Number.isInteger(ttlSeconds) && ttlSeconds > 1 ? ttlSeconds : 60;
    const intervalMs = Math.max(1_000, Math.floor((safeTtl * 1_000) / 3));
    let lockLost = false;
    let renewing = false;
    const renewal = setInterval(() => {
        if (renewing || lockLost)
            return;
        renewing = true;
        void redis.renewLock(key, token, safeTtl)
            .then((renewed) => {
            if (!renewed) {
                lockLost = true;
                logger.error(`Lost Redis lease for ${key}; aborting remaining work`);
                onLost?.();
            }
        })
            .catch((error) => {
            lockLost = true;
            logger.error(`Redis lease renewal failed for ${key}; aborting remaining work`, error instanceof Error ? error.stack : String(error));
            onLost?.();
        })
            .finally(() => {
            renewing = false;
        });
    }, intervalMs);
    renewal.unref?.();
    return {
        lost: () => lockLost,
        stop: () => clearInterval(renewal),
    };
}
function safeErrorMessage(error, maxLength = 4_000) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maxLength);
}
function parseStrictInteger(raw, fallback, min, max) {
    if (raw === undefined || raw.trim() === '')
        return fallback;
    if (!/^[+-]?\d+$/.test(raw.trim()))
        return fallback;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}
function parseStrictBoolean(raw, fallback = false) {
    if (raw === undefined || raw.trim() === '')
        return fallback;
    return raw.trim().toLowerCase() === 'true' ? true : raw.trim().toLowerCase() === 'false' ? false : fallback;
}
