export const MAX_WEBHOOK_ATTEMPTS = 5;

// Matches the provider's documented retry cadence while keeping retries bounded.
export const WEBHOOK_RETRY_DELAYS_SECONDS = [120, 600, 1800, 5400, 12600] as const;

export function getWebhookRetryAt(attempt: number, now = new Date()): Date {
  const boundedAttempt = Math.min(Math.max(attempt, 1), WEBHOOK_RETRY_DELAYS_SECONDS.length);
  const delaySeconds = WEBHOOK_RETRY_DELAYS_SECONDS[boundedAttempt - 1];
  return new Date(now.getTime() + delaySeconds * 1000);
}
