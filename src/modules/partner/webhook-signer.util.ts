// GAP-F (G464/G465): outbound webhook signing + verification.
// Signature = HMAC-SHA256(secret, `${timestamp}.${eventId}.${body}`), hex.
// Headers: X-Kahade-Signature, X-Kahade-Timestamp, X-Kahade-Event-Id.

import { createHmac, timingSafeEqual } from 'crypto';

export function signWebhookPayload(secret: string, timestamp: string, eventId: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${eventId}.${body}`, 'utf8').digest('hex');
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  eventId: string,
  body: string,
  signature: string,
): boolean {
  const expected = signWebhookPayload(secret, timestamp, eventId, body);
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
