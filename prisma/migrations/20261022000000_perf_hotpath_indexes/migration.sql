-- Perf 2026-10-10: index untuk hot path yang belum ter-cover.
--
-- 1. report_assignments(reportId, unassignedAt)
--    Dipakai admin-showcase-reports.service.ts (bulk assignment view):
--    WHERE "reportId" IN (...) AND "unassignedAt" IS NULL.
--
-- 2. courier_webhook_logs(providerCode, idempotencyKey)
--    Dipakai courier.service.ts pada SETIAP webhook masuk (dedupe):
--    WHERE "providerCode" = $1 AND "idempotencyKey" = $2 AND "outcome" IN (...).

CREATE INDEX IF NOT EXISTS "report_assignments_reportId_unassignedAt_idx"
  ON "report_assignments" ("reportId", "unassignedAt");

CREATE INDEX IF NOT EXISTS "courier_webhook_logs_providerCode_idempotencyKey_idx"
  ON "courier_webhook_logs" ("providerCode", "idempotencyKey");
