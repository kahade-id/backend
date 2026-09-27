// GAP-F (G452-G475): Public Partner API & outbound webhooks.
// Central constants: scopes, webhook event registry, retry schedule, key format.

/** Granular scopes for partner API keys (G454). Whitelist — unknown scopes rejected. */
export const PARTNER_SCOPES = [
  'orders:read',
  'payments:read',
  'webhooks:manage',
  'webhooks:read',
] as const;
export type PartnerScope = (typeof PARTNER_SCOPES)[number];

/** Business event registry for outbound webhooks (G462). Whitelist constant. */
export const PARTNER_WEBHOOK_EVENTS = [
  'order.completed',
  'payment.received',
  'payout.completed',
  'subscription.activated',
  'webhook.test', // synthetic event for endpoint testing (G467)
  'webhook.challenge', // ownership verification challenge (G463)
] as const;
export type PartnerWebhookEvent = (typeof PARTNER_WEBHOOK_EVENTS)[number];

/** API key format: kh_live_<base64url(32B)> or kh_sandbox_<base64url(32B)>. */
export const PARTNER_KEY_PREFIX_LIVE = 'kh_live_';
export const PARTNER_KEY_PREFIX_SANDBOX = 'kh_sandbox_';
export const PARTNER_KEY_RANDOM_BYTES = 32;
/** First 8 chars of the random segment, stored for key identification (G453). */
export const PARTNER_KEY_IDENT_LENGTH = 8;

/** Key rotation overlap window (G455): old key stays valid for 24h. */
export const PARTNER_KEY_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

/** Outbound webhook retry schedule (G466): 1m, 5m, 15m, 1h, 6h — then DLQ. */
export const PARTNER_WEBHOOK_RETRY_DELAYS_MS = [
  60_000, // 1m
  5 * 60_000, // 5m
  15 * 60_000, // 15m
  60 * 60_000, // 1h
  6 * 60 * 60_000, // 6h
];
export const PARTNER_WEBHOOK_MAX_ATTEMPTS = PARTNER_WEBHOOK_RETRY_DELAYS_MS.length + 1; // 6 attempts total

export const PARTNER_WEBHOOK_QUEUE = 'partner-webhook';

/** Anti-replay window (G465): receivers must reject timestamps older than 5 minutes. */
export const PARTNER_WEBHOOK_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

/** Webhook payload version (G472). */
export const PARTNER_WEBHOOK_PAYLOAD_VERSION = '1.0';

/** Signature / timestamp / event-id headers (G464). */
export const PARTNER_SIG_HEADER = 'x-kahade-signature';
export const PARTNER_TS_HEADER = 'x-kahade-timestamp';
export const PARTNER_EVENT_ID_HEADER = 'x-kahade-event-id';

/** API key transport headers. */
export const PARTNER_API_KEY_HEADER = 'x-api-key';
export const PARTNER_API_KEY_AUTH_SCHEME = 'apikey';

/** Default rate limits (G460). */
export const PARTNER_DEFAULT_RATE_LIMIT_PER_MINUTE = 100;
export const PARTNER_RATE_LIMIT_WINDOW_MS = 60_000;
