export declare const MAX_WEBHOOK_ATTEMPTS = 5;
export declare const WEBHOOK_RETRY_DELAYS_SECONDS: readonly [120, 600, 1800, 5400, 12600];
export declare function getWebhookRetryAt(attempt: number, now?: Date): Date;
