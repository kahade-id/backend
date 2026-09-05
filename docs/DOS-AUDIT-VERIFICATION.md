# DOS-001 to DOS-015 Verification Matrix

## DOS-001: CRITICAL - No global API rate limit (duplicate of SEC-001)
- **Status**: VERIFIED FIXED (Task #1)
- **Location**: `.backend/src/common/guards/user-throttle.guard.ts`
- **Evidence**: `UserThrottleGuard` implements sliding window rate limiting via Redis `evalSlidingWindow`. Applied globally with configurable `throttleGlobalTtlMs` (default 60s) and `throttleGlobalLimit` (default 100 req/window).

## DOS-002: HIGH - WebSocket rate limiting gaps (duplicate of SEC-016)
- **Status**: VERIFIED FIXED (Task #1)
- **Location**: `.backend/src/modules/realtime/realtime.gateway.ts` lines 28-80
- **Evidence**: `checkWsRateLimit` (30 msgs / 10s), `checkTypingRateLimit` (5 events / 3s), `WS_MAX_CONNECTIONS_PER_USER = 5`. All WS message handlers call rate limit checks. Fail-closed on Redis errors.

## DOS-003: MEDIUM - Global per-IP rate limiter
- **Status**: VERIFIED FIXED (pre-existing)
- **Location**: `.backend/src/common/guards/user-throttle.guard.ts` lines 14-54
- **Evidence**: Guard extracts IP from `x-real-ip`, `x-forwarded-for`, or `req.ip`. Uses `ip:` prefix key for unauthenticated requests. Sliding window enforced per-IP. Fails closed with `ServiceUnavailableException`.

## DOS-004: MEDIUM - OTP generation per-IP + per-user rate limits
- **Status**: VERIFIED FIXED (pre-existing)
- **Location**: `.backend/src/modules/auth/otp.service.ts` lines 37-76
- **Evidence**: Per-IP rate limit (`OTP_IP_RATE_LIMIT = 20/hour`), per-email rate limit (`OTP_EMAIL_RATE_LIMIT = 10/hour`), cooldown (`OTP_COOLDOWN_SECONDS = 60`), max active OTPs per email (`MAX_ACTIVE_OTPS_PER_EMAIL = 3`). All enforced via Redis counters.

## DOS-005: MEDIUM - Cache index parsed lazily with in-memory cache
- **Status**: FIXED in this task
- **Location**: `lib/offlineCache.ts` lines 537-553
- **Evidence**: Added `_indexCache` in-memory variable. `getIndex()` returns cached data on subsequent calls. `saveIndex()` updates in-memory cache. `_clearAllCacheInternal()` resets cache to null.

## DOS-006: MEDIUM - Upload enforces minimum file size
- **Status**: VERIFIED FIXED (pre-existing)
- **Location**: `.backend/src/modules/upload/upload.service.ts` lines 23, 262-269
- **Evidence**: `MIN_FILE_SIZE = 1024` (1KB). Checked in `confirmUpload()`: `if (contentLength !== undefined && contentLength < MIN_FILE_SIZE)` throws `BadRequestException`. Also returned in presigned URL response as `minFileSize`.

## DOS-007: LOW - Offline queue full notification surfaced to user
- **Status**: FIXED in this task
- **Location**: `lib/offlineMutationQueue.ts` lines 10, 202-209; `app/_layout.tsx` lines 400-419; `lib/i18n/common.ts` lines 217-221
- **Evidence**: `OFFLINE_QUEUE_FULL_EVENT` emitted when queue >= `MAX_QUEUE_SIZE`. UI listener in `_layout.tsx` shows warning dialog. i18n translations added for ID/EN.

## DOS-008: LOW - Push token regex allows FCM format (including '/')
- **Status**: VERIFIED FIXED (pre-existing)
- **Location**: `.backend/src/modules/notifications/notifications.service.ts` line 210
- **Evidence**: Regex `^[a-zA-Z0-9:._\/\-]+$` explicitly includes `\/` for FCM token format with forward slashes.

## DOS-009: MEDIUM - Push notification double-delivery fixed
- **Status**: FIXED in this task
- **Location**: `.backend/src/modules/chat/chat.service.ts` lines 412-424; `.backend/src/modules/notifications/notifications.service.ts` lines 38-51
- **Evidence**: `isDuplicateByRef()` checks for existing notification with same `refId` (stable key: `chat:roomId:senderId`) within 60s dedup window. Notification stores `refType`/`refId` for indexed lookup. Avoids false suppression from identical message body text.

## DOS-010: LOW - Frontend search results capped at reasonable limit
- **Status**: VERIFIED FIXED (pre-existing)
- **Location**: `.backend/src/modules/users/user-search.service.ts` line 17; `.backend/src/common/constants/app.constants.ts` line 65
- **Evidence**: `SEARCH_MAX_RESULTS = MAX_LIMIT` applied via `Math.min(Math.max(1, limit), SEARCH_MAX_RESULTS)`.

## DOS-011: LOW - Notification batch operations use soft delete
- **Status**: FIXED in this task
- **Location**: `.backend/src/modules/notifications/notifications.service.ts`; `.backend/prisma/schema.prisma` line 1505; migration `20260409_add_notification_deleted_at`
- **Evidence**: `deleteBatch()` and `deleteNotification()` now set `deletedAt` instead of hard delete. All query paths (list, count, markRead, markBatchRead, markAllRead, isDuplicate) filter `deletedAt: null`.

## DOS-012: LOW - OG metadata cache invalidated on profile update
- **Status**: FIXED in this task
- **Location**: `.backend/src/modules/users/og-metadata.service.ts` lines 75-78; `.backend/src/modules/users/users.service.ts` lines 195-204
- **Evidence**: `invalidateUserOgCache()` method deletes Redis key `og:user:{username}`. Called from `updateProfile()` for both old and new username.

## DOS-013: LOW - Profanity filter handles Indonesian compounds
- **Status**: FIXED in this task
- **Location**: `.backend/src/modules/users/profile-qa.service.ts` lines 19-24
- **Evidence**: Regex updated from `\b{word}\b` to `(?:^|\s|[^a-zA-Z]){word}(?:$|\s|[^a-zA-Z]|an|nya|in|kan|lah|kah)` to catch Indonesian suffixed forms like "anjingan", "babinya", "tololin".

## DOS-014: LOW - Voucher query deduplicated
- **Status**: FIXED in this task
- **Location**: `.backend/src/modules/vouchers/vouchers.service.ts` lines 22-107
- **Evidence**: Extracted `VOUCHER_SELECT`, `serializeVouchers()`, `buildActiveVoucherWhere()`, and `fetchVoucherPage()` helper methods. Eliminated duplicate query blocks for page 1 vs other pages.

## DOS-015: LOW - Admin dashboard queries cached
- **Status**: VERIFIED FIXED (pre-existing)
- **Location**: `.backend/src/modules/admin/dashboard/dashboard.service.ts` lines 8-9, 20-67
- **Evidence**: `DASHBOARD_SUMMARY_CACHE_KEY = 'dashboard:summary_v1'` with `DASHBOARD_SUMMARY_TTL = 60` seconds. Redis-cached with `setex`.
