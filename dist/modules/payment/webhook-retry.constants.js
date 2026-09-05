"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WEBHOOK_RETRY_DELAYS_SECONDS = exports.MAX_WEBHOOK_ATTEMPTS = void 0;
exports.getWebhookRetryAt = getWebhookRetryAt;
exports.MAX_WEBHOOK_ATTEMPTS = 5;
exports.WEBHOOK_RETRY_DELAYS_SECONDS = [120, 600, 1800, 5400, 12600];
function getWebhookRetryAt(attempt, now = new Date()) {
    const boundedAttempt = Math.min(Math.max(attempt, 1), exports.WEBHOOK_RETRY_DELAYS_SECONDS.length);
    const delaySeconds = exports.WEBHOOK_RETRY_DELAYS_SECONDS[boundedAttempt - 1];
    return new Date(now.getTime() + delaySeconds * 1000);
}
