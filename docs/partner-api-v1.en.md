# Partner API v1 — Reference (English)

Base URL: `https://api.kahade.id/v1` · Webhook payload version: `1.0`
Indonesian version: `docs/partner-api-v1.md`.

## Authentication

All `/v1/partner/*` endpoints use an **API key** (never a user JWT).

- Header: `X-API-Key: kh_live_...` (or `Authorization: ApiKey kh_live_...`).
- Key format: `kh_live_<32 bytes base64url>` for production,
  `kh_sandbox_<32 bytes base64url>` for sandbox.
- The key is **shown exactly once** when issued/rotated by an admin.
  Store it in a secret manager; Kahade cannot display it again.

### Granular scopes

Every key carries a scope list. Endpoints reject with `403` when a scope is missing.

| Scope | Access |
|---|---|
| `orders:read` | `GET /v1/partner/orders/:publicId` |
| `payments:read` | Client-owned payment endpoints (when enabled) |
| `webhooks:read` | `GET /v1/partner/webhooks/health` |
| `webhooks:manage` | Endpoint registration & `POST /v1/partner/webhooks/verify-challenge` |

## Rate limiting & quota

- Per-client, per-endpoint rate limit: default **100 req/min** (configurable per
  client via `rateLimitPerMinute`). Exceeding it returns `429` with a `Retry-After` header.
- Daily quota: default **10,000 req/day** per client (`quotaPerDay`).
- Usage is recorded daily per endpoint (`PartnerApiUsage`); admins monitor it
  from the portal without ever seeing secrets.

## Sandbox

- Sandbox keys are valid **only** on `/v1/partner-sandbox/*` — 100% synthetic
  data, never touching production balances or data.
- Production keys are valid **only** on `/v1/partner/*`. Environment mismatch is
  rejected (`401`).

## Endpoints

### GET /v1/partner/orders/:publicId
Scope: `orders:read`. Client-owned order detail (whitelisted fields, no PII).

```json
{
  "publicId": "ORD-9X2KQ",
  "status": "COMPLETED",
  "items": [{ "name": "Arabica Coffee 250g", "qty": 2, "unitPrice": 75000 }],
  "totalAmount": 150000,
  "createdAt": "2026-09-20T10:00:00.000Z",
  "completedAt": "2026-09-22T14:30:00.000Z"
}
```

### GET /v1/partner/webhooks/health
Scope: `webhooks:read`. Webhook subscription status: endpoint list, subscribed
events, `isActive`, `lastDeliveryStatus`.

### POST /v1/partner/webhooks/verify-challenge
Scope: `webhooks:manage`. Body: `{ "endpointId": "...", "challenge": "<token>" }`.
Echoes the challenge token Kahade POSTed to the endpoint URL at registration.
Success → endpoint becomes `isActive=true` and starts receiving events.

## Outbound webhooks (Kahade → partner)

### Registration
Endpoints are registered through the admin portal (SUPER_ADMIN). URL rules
(anti-SSRF): HTTPS only, port 443, no credentials in the URL, and the hostname/IP
must not resolve to private/reserved/loopback/link-local/multicast/cloud-metadata
ranges (`127.0.0.1`, `10.0.0.0/8`, `169.254.169.254`, etc. — DNS is resolved and
every resulting IP is checked). When `PARTNER_EGRESS_ALLOWLIST` is set, only
CIDRs on the list are allowed.

### Ownership verification
On creation, Kahade POSTs a `webhook.challenge` event containing a random
`challengeToken`. The partner echoes the token via `verify-challenge` above.
The endpoint stays **inactive** until verification succeeds.

### Delivery format
Headers on every delivery:

| Header | Content |
|---|---|
| `X-Kahade-Signature` | HMAC-SHA256 hex of `timestamp.eventId.body` using the endpoint secret |
| `X-Kahade-Timestamp` | epoch millis at send time |
| `X-Kahade-Event-Id` | UUID unique per event (idempotency key) |

Body (JSON, `version: "1.0"`):

```json
{
  "version": "1.0",
  "eventId": "evt_01J...",
  "eventType": "order.completed",
  "occurredAt": "2026-09-26T13:00:00.000Z",
  "data": { "publicId": "ORD-9X2KQ", "status": "COMPLETED", "totalAmount": 150000 }
}
```

### Signature verification (pseudocode)

```
expected = HMAC_SHA256(secret, timestamp + "." + eventId + "." + rawBody)
if !constantTimeEqual(expected, header("X-Kahade-Signature")): reject
if abs(now - timestamp) > 5 minutes: reject        // anti-replay
if eventId already processed: skip (idempotent)     // anti-replay
```

### Available events

`order.completed`, `payment.received`, `payout.completed`,
`subscription.activated`, `webhook.test` (manual testing), `webhook.challenge`.

### Retry & DLQ
Failures (non-2xx / 60s timeout) are retried with exponential backoff:
**1 min → 5 min → 15 min → 1 hr → 6 hr**, then moved to the **DLQ** after
6 attempts. Admins can manually replay from the portal — replays reuse the same
`eventId`, so they are idempotent on the receiver side.

## Common error codes

| Code | Meaning |
|---|---|
| `401` | Missing/invalid/expired/revoked API key, or wrong environment |
| `403` | Insufficient scope, or client suspended |
| `404` | Resource missing / not owned by the client |
| `429` | Rate limit / quota exceeded (`Retry-After` in seconds) |

See also: `docs/partner-api-product.md` (product definition),
`docs/partner-security-contract.md` (security contract & anti-replay),
`docs/partner-webhook-changelog.md` (payload versioning).
