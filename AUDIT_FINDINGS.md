# Deep Audit — Findings & Fixes (2026-09-11)

**Method.** Full static audit of `src/` (≈400 files, ~56k LOC) plus deploy/CI/config;
every finding below is **proven** from the code in this repo (file:line) — where possible
by executing the verification harnesses: `npx tsc --noEmit`, `npx eslint`, and the jest
suite (baseline 1294 passed / 1 failed; the failure itself was finding #2). No
speculative issues are listed.

**Legend:** [CRIT]/[HIGH]/[MED]/[LOW] · all items are FIXED in this branch.

---

## A. Broken email notifications (missing `.hbs` templates) — 9 issues

The email worker renders `templateName` at consume time; a missing file or an
allowlist miss throws inside every job (retried 3×, then the alert is lost forever).

1. **[HIGH] `transfer-sent`** — allowlisted (template.service.ts) but
   `src/templates/email/transfer-sent.hbs` did not exist → every transfer confirmation
   email failed (wallet.service.ts transfer()).
2. **[HIGH] `transfer-received`** — same missing file.
3. **[HIGH] `password-changed-notification`** — missing file **and** not allowlisted
   (auth.service.ts:2024) → users never learn their password was changed.
4. **[HIGH] `phone-changed-notification`** — missing file, not allowlisted (auth.service.ts:670).
5. **[HIGH] `two-fa-enabled-notification`** — missing, not allowlisted (auth.service.ts:2162).
6. **[HIGH] `two-fa-disabled-notification`** — missing, not allowlisted (auth.service.ts:2293)
   — disabling 2FA is exactly the event the user must be alerted about.
7. **[MED] `backup-codes-regenerated-notification`** — missing, not allowlisted (auth.service.ts:2372).
8. **[HIGH] `refresh-token-reuse-detected`** — missing, not allowlisted (auth.service.ts:2727) —
   the theft alarm never fires.
9. **[MED] `kyc-revoked`** — missing, not allowlisted (admin-kyc.service.ts:305) — revoked users
   never got the "why" email.
   *Fix:* created all nine templates (escaped double-curly Handlebars, matching existing
   style) and extended `ALLOWED_TEMPLATES`.

## B. Non-atomic Redis counters (INCR without durable TTL) — 20 sites, 1 shared root cause

`incr()` then `if (count === 1) expire()` loses the TTL whenever the second command
fails (transient error/crash) — the key then **never expires**, converting a
rate-limit into a permanent lockout (or permanent fail-open when the counter is
displayed as "zero"). All sites switched to a new atomic
`RedisService.incrWithTtl()` (Lua INCR + `EXPIRE` when `TTL < 0`, self-healing):

10. **[HIGH] global throttle** `global_throttle:<ip>` (global-throttle.guard.ts:33-38) — permanent 429 for an IP.
11. **[MED] WS message rate** `ws:msg_rate:*` (realtime.gateway.ts).
12. **[MED] WS typing rate** `ws:typing_rate:*` (realtime.gateway.ts).
13. **[HIGH] login IP bucket** `login_ip_rate:*` (auth.service.ts:1342).
14. **[MED] forgot-password IP bucket** (auth.service.ts:1176).
15. **[MED] forgot-password email bucket** (auth.service.ts:1183).
16. **[LOW] verifyPassword bucket** (auth.service.ts:1866).
17. **[LOW] disable-2FA bucket** (auth.service.ts:2145).
18. **[LOW] regen-backup-codes bucket** (auth.service.ts:2277).
19. **[LOW] requestDisable2faOtp bucket** (auth.service.ts:2360).
20. **[MED] 2FA login attempt window** `TWO_FA_ATTEMPT_KEY` (auth.service.ts:1572).
21. **[MED] escalating lockout cycles** `lockout_cycles:*` (auth.service.ts:1394) — TTL loss pins the
    multiplier at max forever.
22. **[LOW] login-captcha failure counter** (captcha.service.ts:42).
23. **[MED] admin 2FA inline attempts** (admin-auth.service.ts:112).
24. **[MED] admin 2FA temp-token attempts** (admin-auth.service.ts:220).
25. **[LOW] auto-complete per-order failure counter** (auto-complete-orders.service.ts:447) — also fixes
    silent-catch'd TTL error.
26. **[MED] OTP IP rate** — email + phone variants (otp.service.ts:51,109).
27. **[MED] OTP email rate** (otp.service.ts:61).
28. **[MED] OTP phone rate** (otp.service.ts:119).
29. **[HIGH] wallet-PIN attempt + PIN-IP attempt buckets** (wallet.service.ts:914,977) — permanent
    "too many PIN attempts" for innocent CGNAT neighbors.

## C. Repo / CI / deployment — 11 issues

30. **[CRIT] CI `npm ci` without a tracked lockfile** — `git ls-files package-lock.json`
    is empty while ci.yml runs `npm ci` → the pipeline fails before any test runs; builds
    are also non-reproducible. *Fix:* committed the generated `package-lock.json`.
31. **[HIGH] `order-contract-artifacts.spec.ts` read `/home/user/admin/lib/openapi.json`**,
    a file from another repository → the only failing test on a clean checkout (proven by jest).
    *Fix:* backend asserts only against the repo-local `openapi.json`.
32. **[HIGH] `dist/` (836 files) committed to git; `.gitignore` didn't exclude build output** →
    stale compiled JS shipped next to `src`, and `npm start` can run outdated code.
    *Fix:* `.gitignore` + `git rm -r --cached dist`.
33. **[HIGH] Dockerfile written for a nonexistent pnpm monorepo** (`apps/backend/*`,
    `pnpm-lock.yaml`) → `docker build` always fails. *Fix:* rewrote for flat npm layout
    (deps/builder/prod-deps/runtime, non-root, tini, HEALTHCHECK).
34. **[HIGH] docker-compose `build.context: ../..` + `dockerfile: apps/backend/Dockerfile`**
    → compose build always fails. *Fix:* `context: .`, `dockerfile: Dockerfile`.
35. **[MED] entrypoint.sh ran `prisma migrate deploy` + constraints on every container with no
    coordination** while `start.sh` already serialises the same with `pg_advisory_lock` →
    concurrent migrations when scaling out. *Fix:* same advisory lock in entrypoint.sh.
36. **[MED] deploy/nginx.conf: `upstream … keepalive 32` never engaged** — no
    `proxy_set_header Connection "";`, so every proxy request sent `Connection: close`.
    *Fix:* added.
37. **[HIGH] deploy/nginx.conf `/socket.io/`: setting `Upgrade`/`Connection` headers silently
    dropped inheritance of server-level `Host/X-Real-IP/X-Forwarded-*`** (nginx
    proxy_set_header semantics) → the app saw nginx's IP as the client for every WS
    handshake, breaking IP-bound logic. *Fix:* headers set explicitly in that location.
38. **[MED] deploy/nginx.conf webhook "rate-limit exempt" comment was false** — the
    server-level `limit_req` applies to every location → bursts of provider webhooks were
    503'd. *Fix:* dedicated `webhook_limit` zone for the location.
39. **[MED] deploy/nginx.conf `client_max_body_size 10k`** contradicted the app's documented
    1 MB JSON limit (main.ts) with an opaque early 413. *Fix:* aligned to 1m.
40. **[LOW] compose nginx (`nginx/nginx.conf`): same `keepalive` never-engaged bug** for
    `/v1/` and `/v1/auth/`. *Fix:* `Connection ""` added.

## D. Auth / security semantics — 8 issues

41. **[MED] `login()` counted successful logins against the shared per-IP budget** with no
    reset (auth.service.ts:1342) — 20 legitimate logins from one CGNAT IP lock out every
    household behind it. `verifyPassword` already deletes its bucket on success; login did
    not. *Fix:* success decrements the counter by one.
42. **[HIGH] `POST /auth/verify-email` enumeration/status oracle**: 404 USER_NOT_FOUND and
    403 ACCOUNT_INACTIVE (auth.service.ts:1014-1021) while every sibling flow — including
    the GET magic-link of the *same* flow — returns one generic message.
    *Fix:* collapsed to the generic OTP-invalid failure.
43. **[HIGH] `POST /auth/reset-password` enumeration oracle**: 404/403 before OTP check
    (auth.service.ts:1216-1228). *Fix:* generic invalid-code response.
44. **[MED] Login-time bcrypt cost-factor upgrade stamped `passwordChangedAt`**
    (auth.service.ts:1477) — a field that means "the user rotated their password"
    (exposed at users.service.ts:76; the natural key for future `iat <` session
    invalidation). A re-hash is not a user event. *Fix:* no longer set on upgrade.
45. **[HIGH] Refresh-token rotation burned ~500 ms of bcrypt per refresh** (saveSession
    `bcryptHash(sha256(token))`; refreshToken `bcryptCompare` + re-hash, cost 12 floor —
    crypto.util.ts `MIN_BCRYPT_ROUNDS`). Refresh tokens are 256-bit signed JWTs; bcrypt's
    GPU-resistance is for low-entropy secrets (OWASP). At fleet scale this is the hottest
    CPU item on the box.
    *Fix:* store `sha256(token)`, verify with constant-time hex compare; legacy `$2…`
    bcrypt hashes keep verifying and upgrade transparently on rotation.
46. **[MED] Idempotency replay returned the wrong HTTP status** — short-circuiting the
    handler skipped `@HttpCode`, so 200-marked POSTs (e.g. `/wallet/withdraw/cancel`)
    replayed as 201; the ledger's stored `statusCode` was a hardcoded 200 that nothing
    read (idempotency.interceptor.ts:146,172-217).
    *Fix:* replays re-assert the handler's `HTTP_CODE_METADATA`.
47. **[MED] `expandIPv6('a::b::c')` accepted double-'::'**, splitting to ['a','b','c'] and
    silently dropping segments after the second marker → a mangled address that can match
    an allowlist prefix (payment.service.ts:559).
    *Fix:* reject inputs with more than one '::'.
48. **[MED] Withdrawal-confirmation OTP fixed at 6 digits for a financial action** — the
    repo's own SEC-019 note (otp.util.ts:8-11) recommends 8 for money movement; the DTO
    even hard-caps at 6 (`ConfirmWithdrawOtpDto`).
    *Fix:* `app.withdrawOtpDigits` (WITHDRAW_OTP_DIGITS, 6–10, default 6 for client
    compatibility) drives `generateOtp`; DTO accepts 6–10 digits.

## E. Orders / escrow / payments / wallet — 8 issues

49. **[MED] Soft-deleted-order state machine gap** — `Order.deletedAt` exists (prisma
    schema) and user-facing reads, crons and WS rooms all filter `deletedAt: null`, but
    every money/state transition read it unfiltered: order-state confirm/reject/pay/
    complete/cancel/adminCancel, order-qris initiate + settlement guard, disputes
    submit, extensions, delivery-proof. A deleted order could keep moving funds while
    the auto-complete/expire crons no longer see it → stranded escrow.
    *Fix:* `deletedAt: null` guards on the reads **and** the conditional updateMany
    claims.
50. **[MED] `getAvailableVouchers` clobbered the requested audience filter** — for users
    with completed orders `where.applicableTo = { not: NEW_USER }` overwrote
    `applicableTo=BUYER_ONLY/SELLER_ONLY`, listing the other side's vouchers
    (vouchers.service.ts:113-116).
    *Fix:* keep the requested filter; only exclude NEW_USER when none was given.
51. **[MED] WS connection-lease leak**: `handleConnection` registers the `ws:conn:<user>`
    lease, and only `handleDisconnect` (keyed on `client.userId`) releases it; errors
    raised after lease registration but before `client.userId` assignment leaked the slot
    for the full 20-minute TTL — repeated failures then hit
    `WS_MAX_CONNECTIONS_PER_USER` forever (realtime.gateway.ts:294-345).
    *Fix:* lease key tracked on the socket; the catch releases it.
52. **[LOW] `transfer()` wrote the raw `note` into `WalletTransaction.metadata`** while
    `description` went through control-char stripping + 200-char clamp
    (wallet.service.ts:1620-1640) — clients reading `metadata.note` bypass the
    sanitisation contract. *Fix:* metadata now stores `safeNote`.
53. **[MED] Stale `subscription_status:<userId>` fee-cache** — orders.service caches the
    Plus flag for 300 s at order-creation time; subscribe/cancel/renew and the expiry cron
    never invalidated the key (grep: only orders.service touches it), so discounts kept
    applying after expiry (revenue leak) or didn't apply right after purchase, and
    `completeOrder` could debit `feeSavingsUsed` against a dead subscription.
    *Fix:* delete the cache key in subscribe, cancel, renew, and the expiry cron.
54. **[LOW] Wallet-statement CSV/XLSX exported the internal `id` in the "Transaction ID"
    column** instead of the human `txId` shown by the API/app (export.service.ts:109,177)
    → statements can't be reconciled with support tickets; and *leaks* the internal PK.
    *Fix:* export `tx.txId`.
55. **[LOW] Statement dates were raw UTC** (`createdAt.toISOString()`) under a column with no
    timezone annotation, while the whole product speaks WIB (export.service.ts:99,175).
    Between 00:00–07:00 WIB the row dates printed as "yesterday".
    *Fix:* format via `toWIB(...)`; also pinned receipts (`receipt.service.ts:55,108,109,138`)
    and transfer-email dates (wallet.service.ts:1989,2010) to `Asia/Jakarta`.
56. **[LOW] `RedisService.delPattern()` swallowed SCAN/DEL failures** (redis.service.ts:126)
    while `getOrCompile`… and its admin voucher callers reported "invalidated" even when
    deletion failed (stale public voucher list up to 300 s).
    *Fix:* `throwOnError` option; admin-vouchers invalidation now strict with a loud
    CRITICAL log; removed the dead-but-misleading `VouchersService.invalidateAvailableVouchersCache`.

## F. Application surface hardening — 3 issues

57. **[HIGH] Helmet CSP was applied to `/docs`**: `scriptSrc 'none'` + `defaultSrc 'none'`
    block swagger-ui-express' inline bootstrap script and the `/docs-json` fetch, so the
    docs UI was guaranteed-dead in every environment where it's enabled (main.ts:183-196).
    *Fix:* the strict CSP now skips exactly the docs paths under the same
    dev/allowlist/IP-guard gating as the docs themselves.
58. **[MED] Reserved-username blocklist bypass**: `RESERVED_USERNAMES` is enforced at
    register/phoneRegister/setUsername (auth.service.ts:151,762,958) but not in
    `users.service.updateProfile`'s username change → rename to `admin`/`support` =
    impersonation vector. *Fix:* same reserved-name + shape checks in updateProfile.
59. **[LOW] `PUT /users/me` performed a password `bcryptCompare` with only the global
    100/min throttle** (users.controller.ts:61) — looser than every other
    password-confirmation flow (5/15 min). *Fix:* route throttle 10/15 min.

## G. Hygiene — 1 issue

60. **[LOW] ESLint unused import `decryptAES`** in kyc.service.ts:7 (only remaining lint
    diagnostic). *Fix:* removed.

---

### Investigated and deliberately NOT changed (avoided false positives)

- `$queryRaw` array binding in search (verified Prisma 5.22 serializes arrays as `$1::text[]` — valid).
- `WALLET_LOCK(userId)` "walletId" param naming (all 5 call sites consistently pass userId).
- `wallet-tx-serial` first-in-day sync race (harmless: txId carries a random suffix; unique constraint not serial-based).
- CSRF token single-use semantics, Midtrans refund/partial-reversal amount validation, dispute decision math
  (buyer+seller+platform == escrow, floor-div remainder to seller), `adminCancelOrder` QRIS refund deferral,
  trusted-device 2FA skip (requires an authenticated trust grant), `getPublicProfile` contact masking,
  scheduled-withdrawal ceilings/lazy-reset logic, sessions revoke ownership checks, Sentry PII scrubbing.
---

# Round 2 — 54 additional proven issues (same audit rules: each entry cites file:line proof; speculation excluded)

Legend: severity in [BRACKETS]. “Proof” = the code evidence that made this a real defect, not a style opinion.
All fixes landed in `arena/01a0917c-backend`; gates after Round 2: `tsc --noEmit` 0 errors, `eslint` 0 problems, full Jest suite green.

## H. Kahade+ quota accounting vs. the `subscription_status` cache — 5 issues

`orders.service` caches `subscription_status:<userId>` for 300 s (read when quoting order fees, incl. remaining Plus fee-savings quota) and every other quota-mutating path invalidates it (`subscriptions.service.ts:272` is the reference pattern). Four places mutate the quota without invalidation; one admin path mutates the entitlement itself.

61. **[MED] `OrderStateService.completeOrder` increments `feeSavingsUsed` (order-state.service.ts:641–655) but never deletes the cache** → after completing an order the buyer kept being quoted the stale remaining quota for up to 5 min. *Fix:* post-commit `redis.del`, mirroring `subscriptions.service.ts:272`. (New spec: cache-invalidation covered by full suite.)
62. **[MED] `MutualResolutionService.acceptProposal`** — same increment (mutual-resolution.service.ts:493–518) with no invalidation; the service did not even depend on `RedisService`. *Fix:* injected `RedisService` (DisputesModule already imports `RedisModule`) + `runPostCommitBestEffort` delete.
63. **[MED] `AdminOrdersService.forceComplete`** — same increment (admin-orders.service.ts:388–397) with no invalidation. *Fix:* `RedisService` injected (module updated), delete after the tx.
64. **[MED] `AutoCompleteOrdersService` cron** — same increment (auto-complete-orders.service.ts:310–330); the auto-completion path left the stale cache the interactive path clears. *Fix:* delete for `isKahadePlus` buyers post-commit.
65. **[MED] `AdminSubscriptionsService.forceCancelSubscription`** flips status + `isKahadePlus` (admin-subscriptions.service.ts:119–190) but never invalidated `subscription_status:<userId>` — users kept Plus rates for up to 5 min after an admin cancellation. *Fix:* service gained `RedisService` (+ `RedisModule` import in its module) and deletes after the tx.

## I. Soft-deleted orders processed by money-moving paths — 5 issues

Round 1 established the rule: every order mutation must carry `deletedAt: null` (e.g. `adminCancelOrder`). These paths predate/missed it and move money or state.

66. **[HIGH] `AdminOrdersService.forceComplete` could force-complete a SOFT-DELETED order**: initial read (admin-orders.service.ts:147, 177) and the status claim (`tx.order.updateMany` :227) lacked `deletedAt: null` — escrow released, seller credited, counters bumped — while the guarded cancel path refuses the same order. *Fix:* guards added on all three queries; spec `admin-orders.service.spec.ts` updated (RedisService provider).
67. **[HIGH] `AutoCompleteOrdersService` auto-completed soft-deleted orders**: candidate `findMany` (:73–76) and fresh re-read (:119–124) had no `deletedAt`, and both claims (:160–161 grace extension, :183–184 completion) accepted deleted rows. *Fix:* guard in all four places.
68. **[LOW] `ExpireUnpaidOrdersService`** scanned + cancelled soft-deleted orders (candidate :56–60, claim :74) → users got cancellation notices for orders already removed from their list. *Fix:* `deletedAt: null` on both.
69. **[LOW] `ExpireUnconfirmedOrdersService`** — identical gap (candidate :56–60, claim :75). *Fix:* same.
70. **[MED] `InvoiceService.getInvoiceData`** looked up `where: { orderId }` only (invoice.service.ts:11) → invoices (buyer/seller names, amounts) remained retrievable for soft-deleted orders, unlike every other order read. *Fix:* `deletedAt: null`.

## J. Ledger / counter atomicity — 2 issues

71. **[MED] `WalletTxSerialService.getNextForPrefix` day-start sync bypassable by concurrent losers** (wallet-tx-serial.service.ts:54–92 pre-fix): only the caller receiving `INCR == 1` ran the DB re-sync; racers that drew 2..N returned those raw values even when PostgreSQL already held higher serials for the day → financial rows recorded with duplicate day-serials. (Round 1 had dismissed this as “harmless” because ids carry a random suffix so no P2002 — but the serial-uniqueness guarantee the recovery sync exists to provide was still silently lost, which corrupts ledger reconciliation keyed on serials.) *Fix:* a per-day `:synced` marker gates every early caller: pre-sync callers funnel through the lock (or take it over when the syncer died) and re-draw; post-marker calls trust INCR directly. New spec `wallet-tx-serial.service.spec.ts` (3 tests: concurrent day-start uniqueness incl. min > DB max; no DB hit once synced; marker set without DB history).
72. **[HIGH] `verifyWalletPin` lockout was check-then-increment** (wallet.service.ts:940–957 pre-fix): N parallel requests all read the same attempt count, each getting a free PIN guess before any increment landed; the 5-attempt/15-min lockout could be bypassed by bursts (the counter was only written after bcrypt). *Fix:* atomic `incrWithTtl` reservation checked first (>5 → 403 before bcrypt), released on success; reservation moved after the no-PIN branch so a missing PIN cannot self-lock. Spec updated (`wallet.service.spec.ts` lockout case now drives the reservation counter).

## K. Profile media (avatar/header) presign flow — 5 issues

73. **[HIGH] `ConfirmAvatarDto` regex could never match generated keys** (users/dto/confirm-avatar.dto.ts:9): `^avatars\/[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)$` vs the presigned key shape `avatars/<userId>/<nanoid16>.<ext>` (users.service.ts:547) — every honest confirm returned 400; the presigned avatar upload feature was dead on arrival. *Fix:* regex now requires the `avatars/<uid>/<file>.<ext>` shape; new spec `users/tests/confirm-avatar.dto.spec.ts` proves real keys validate and traversal/wrong-prefix/ext still fail.
74. **[HIGH] Presigned avatar/header PUT had no size cap**: `uploadAvatar`/`uploadHeader` (users.service.ts:540/1675 pre-fix) sign `PutObject` without conditions; the 2 MB/5 MB interceptor limits only cover the *direct* routes; confirm only Range-read 16 magic bytes → anyone could PUT gigabytes to the public bucket. *Fix:* both confirm paths now `HeadObject` the stored size and reject + delete oversized objects (`MAX_AVATAR_BYTES`/`MAX_HEADER_BYTES`, matching direct-path caps) via new shared `verifyStoredImage`.
75. **[MED] `confirmAvatar` leaked the replaced object**: direct path deletes the previous R2 key (users.service.ts:640–657); the presign-confirm path (pre-fix :658–712) updated `avatarUrl` and orphaned the old object. *Fix:* `replaceStoredMedia` after successful update.
76. **[MED] `confirmHeader`** — identical leak for `headerUrl` (pre-fix :1704–1750). *Fix:* same helper.
77. **[LOW] `OrphanedUploadCleanupService` only listed `uploads/`** (orphaned-upload-cleanup.service.ts:104) while abandoned/legacy presign objects live under `avatars/`, `headers/` — they were invisible to the sweeper forever. *Fix:* `cleanupProfileMedia` pass sweeps both prefixes with the DB-reference check the `uploads/` pass was told to require (`user.avatarUrl/headerUrl` set), honoring the same `ORPHAN_CLEANUP_ENABLED` dry-run gate and lease checks.

## L. Token-TTL parser drift — 2 issues

78. **[MED] `parseJwtTtl` (jwt.util.ts) only matched `(\d+)(s|m|h|d|w)`** while `@nestjs/jwt` (via `ms`) also accepts `'2 days'`, `'90 mins'`, etc. — such configs silently parsed as 900 s, so session-revocation/blacklist markers expired long before the tokens (revoked sessions revive). *Fix:* parser now covers spaced/word units, clamps to ≤ 30 d; new spec `jwt.util.spec.ts` (4 tests).
79. **[LOW] `CsrfService` kept its own parser** (csrf.service.ts:5–16 pre-fix) that even lacked `w` → CSRF tokens could expire before the access token they are bound to. *Fix:* local copy removed, uses `parseJwtTtl`.

## M. Support ticket communication — 2 issues

80. **[MED] Admin replies to tickets were invisible**: `AdminSupportService.replyToTicket` (admin-support.service.ts:149–175 pre-fix) created the reply with no in-app notification, no realtime event, no email — users had to poll the list (throttled 30/min) to learn staff answered. *Fix:* `SYSTEM_ANNOUNCEMENT` notification + `emitNotificationCreated` on commit (same pattern as admin-kyc.service.ts:137–146). Spec `admin-support.service.spec.ts` now asserts notification + realtime emission.
81. **[LOW] Terminal status changes were equally silent** (`updateStatus` :177–200): a ticket becoming RESOLVED/CLOSED produced no signal. *Fix:* notify on RESOLVED/CLOSED transitions.

## N. Config cache & support-ticket linkage — 2 issues

82. **[MED] `AdminSystemService.updateConfig` / `approveConfigChange` invalidate five cache keys but not `public:exchange:rates`** (admin-system.service.ts:208–215, 311–316 pre-fix) — `public.service.ts:162` setex’s that key for 300 s; an operator changing the rate config saw stale public rates for up to 5 min (pricing divergence). *Fix:* added to both invalidation blocks.
83. **[LOW] `SupportService.createTicket` accepted any `orderId` string** (support.service.ts:20–34 pre-fix): the ticket→order link is schema-validated nowhere (`orderId String?` no FK, schema.prisma:2396), so users could attach strangers’ order ids to their tickets (staff-context noise/phishing). *Fix:* ownership check (buyer/seller participant, non-deleted) before linking. Spec: 2 new tests in `support.service.spec.ts` (foreign order + missing order both rejected, no ticket created).
## O. Transaction templates — 1 issue

84. **[MED] Usage tracking was dead code**: `recordUsage` (transaction-templates.service.ts:148 pre-fix) had ZERO callers, so `usageCount`/`lastUsedAt` never advanced — while `getMyTemplates` (:15) sorts `lastUsedAt desc`, pinning “most used” as a permanent no-op and making the API’s `usageCount` field always 0. *Fix:* owner-scoped atomic `updateMany` bump + real route `POST /transaction-templates/:id/use` (throttled 30/min, UserThrottleGuard), NotFound for foreign ids. Spec updated: owner scoping + foreign rejection now asserted.

## P. Scheduled withdrawals & validation hardening — 3 issues

85. **[LOW] `createSchedule` raced its own unique index** (scheduled-withdrawal.service.ts:327–345 pre-fix): the `userId_dayOfWeek` pre-check then unconditional `create` → concurrent double-submit surfaced Prisma P2002 as an unhandled 500. *Fix:* P2002 → documented `SCHEDULE_ALREADY_EXISTS` 400.
86. **[LOW] `updateSchedule` same pattern** (pre-fix :393–431): P2002 (day collision) and P2025 (row deleted concurrently) both 500. *Fix:* mapped to 400/404.
87. **[LOW] `ExportCsvDto.types` was unvalidated string[]** (wallet/dto/export-csv.dto.ts pre-fix) fed straight into `where.type.in` (export.service.ts:63) — one bogus value → P2023 500 on the statement-export route. *Fix:* `@IsIn(WalletTransactionType)` each. New spec `wallet/tests/export-csv.dto.spec.ts`.

## Q. Offset-pagination stability (missing deterministic tiebreak) — 16 issues

Skip-based pages sorted by a non-unique key re-shuffle rows between requests (PostgreSQL gives no order guarantee for equal keys): users see duplicates and gaps while paging. Repo convention (already applied in ~20 spots from Round 1) is `[{ sort }, { id }]`; these 16 list queries missed it:

88. [LOW] `AdminCampaignService.listCampaigns` (:104)
89. [LOW] `AdminDisputesService.listDisputes` (:63)
90. [LOW] `AdminSystemService.webhook-log list` (:452)
91. [LOW] `DisputesService.list` (:112)
92. [LOW] `DisputesService.evidence list` (:159)
93. [LOW] `DisputeMessageService.getMessages` (:59)
94. [LOW] `KycService.getHistory` (:277)
95. [LOW] `NotificationsService.list` (:117)
96. [LOW] `RatingsService.given` (:166)
97. [LOW] `RatingsService.received` (:181)
98. [LOW] `UserSearchService.searchUsers` (discover; equal rank rows shuffled — `id asc` tiebreak)
99. [LOW] `UsersService.getFollowers` (:1408 area)
100. [LOW] `UsersService.getFollowing`
101. [LOW] `UsersService.getBlockedUsers`
102. [LOW] `WalletService.getTransactions` (:338)
103. [LOW] `SupportService.getTickets` (:41)

All fixed by adding the `{ id }` tiebreak matching each sort direction (spec mock in `dispute-message.service.spec.ts` updated to honor array-form `orderBy`, proving the C-21 newest-window contract still holds).

## R. SQL LIKE wildcard escaping in search — 9 issues

PostgreSQL `contains` = `LIKE '%x%'`; unescaped `%`/`_`/`\` in free-text turned user queries into patterns (“searching `100%` matches everything”, `_` matches any char). The repo already had local escapers in `orders.service`/`admin-orders` (proof of intended behavior); 9 endpoints lacked them. Shared helper `common/utils/search.util.ts#escapeLikePattern` (its behavior covered by `search.util.spec.ts`) now used everywhere and the two local copies were refactored to import it:

104. [MED] `HelpCenterService.searchFaq` (:81–84, user-facing)
105. [MED] `SearchService` global search — users (2×) + orders/wallet rows (3×) (:135–218, user-facing)
106. [LOW] `AdminUsersService.listUsers` (:50–53)
107. [LOW] `AdminSupportService.listTickets` (:104–108)
108. [LOW] `AdminDisputesService.listDisputes` (:57–58)
109. [LOW] `AdminManagementService.listAdmins` (:34–36)
110. [LOW] `AdminSystemService` webhook-log search (:441–443)
111. [LOW] `UsersService.getFollowers` search filter (:1396–1397)
112. [LOW] `UserSearchService` OR-fallback (trigram-less path) (:54–55)

## S. Hygiene — 2 issues

113. [LOW] `src/modules/users/dto/upload-media.dto.ts` was a fully dead duplicate module (zero importers repo-wide) containing a second `ConfirmHeaderDto` class that had already drifted from the live one (missing `@MinLength`) — classic copy-paste divergence risk. *Fix:* file deleted.
114. [LOW] `SessionsService` carried an orphaned comment half-erased by an earlier edit (“at 900s — if JWT_EXPIRES_IN…”) documenting the wrong rationale for the revocation-marker TTL. *Fix:* comment rewritten to describe the actual contract (ties into #78).

## Round 2 — investigated and deliberately NOT changed (kept out of the count)

- **KYC upload purpose confusion** — suspected `verifyKycFilesConfirmed` (kyc.service.ts:47) accepted any confirmed key (avatar-as-KTP, same key in both slots). Refuted: `KycController.validateKycFileOwnership` (kyc.controller.ts:64–70) already enforces `uploads/kyc-ktp/<uid>/` vs `uploads/kyc-selfie/<uid>/` prefixes on BOTH submit and resubmit; keys can never be equal. Not filed, not changed.
- **Fee-ledger `balanceBefore` anchor in `forceComplete`** — looked like a stale-balance bug; refuted by comparing with the normal `completeOrder` ledger rows (both anchor pre-decrement intentionally). No change.
- **`getHeldEscrowReleaseAmount` missing `deletedAt` in scheduled-withdrawal mirror** — verified the manual `WalletService` twin is identical (holds conservatively incl. deleted) — the “keep in sync” contract is satisfied; changing only one side would introduce drift.
- **Ban-without-session-kill in `AdminUsersService.banUser`** — refuted: `jwt-auth.guard.checkDatabaseAuthorization` re-reads `isActive/isBanned/deletedAt` per request (fail-closed), and refresh/login both check banned; immediate effect confirmed.
- **CSV/XLSX export formula injection** — refuted: `export.service.ts` `sanitizeCell` guards `= + - @ \t \r` on both CSV and XLSX cells; HTML export escapes via `escapeHtml`.
- **Pending-topup expiry vs. late settlement race** — refuted: cleanup reconciles with Midtrans first, retains non-terminal/errored cases, and only fails provider-confirmed terminal failures (pending-topup-cleanup.service.ts:76–146).
- **Voucher double-count / no release on cancel** — refuted: `currentUsage` decrement exists on all cancel paths (order-state :303/:770/:859, expire crons) with `gt: 0` guard; redeem path locks `FOR UPDATE`.
- **`@Public` GET /users/availability enumeration** — already throttled 5/min/IP with length-bounded input.
- **Admin refresh-token survival after role downgrade (`admin_revoked:` marker TTL)** — refresh handler re-reads role from DB (admin-auth.service), so stale privilege cannot outlive one refresh; marker TTL bound (2 h) matches jwt.config clamp.
- **`deleteAdmin` orphaning refresh rows** — refresh validates `deletedAt: null` + `isActive` per use; no live path.
- **`removeDevice` revoking all `deviceId: null` sessions** — revoking untracked sessions on explicit device removal is fail-safe direction; left as-is with the existing comment.
- **WalletTxSerial “kyc_serial prefix absent from prefixMap”** — `generateKycId` carries the same random suffix; with the new marker protocol a never-synced prefix behaves exactly like a fresh day; acceptable.
- **`rejectWithdrawal` refund of PROCESSING withdrawals** — claim is `PENDING_PROCESS`-only, so a payout-in-flight can’t be refunded; double-spend impossible.
- **`updateConfig` numeric ranges for fee-rate keys** — fee computation clamps at [Rp 5.000, Rp 250.000] downstream, so absurd configs cannot escape the floor/ceiling.

## Round 2 verification

- `tsc --noEmit`: 0 errors.
- `eslint "src/**/*.ts" "test/**/*.ts"`: 0 problems.
- `jest --silent --forceExit` (full): see section below for final counts.
- New specs added this round: `jwt.util.spec.ts`, `search.util.spec.ts`, `wallet-tx-serial.service.spec.ts`, `confirm-avatar.dto.spec.ts`, `export-csv.dto.spec.ts`; extended specs: `support.service.spec.ts` (+2), `admin-support.service.spec.ts` (+1), `transaction-templates.service.spec.ts` (rewritten recordUsage cases), `dispute-message.service.spec.ts`/`wallet.service.spec.ts`/`admin-orders.service.spec.ts`/`mutual-resolution.service.spec.ts`/`scheduler.smoke.spec.ts` (adapted to the fixed contracts).
