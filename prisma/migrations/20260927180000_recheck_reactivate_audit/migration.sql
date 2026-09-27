-- ADM-213/ADM-218 (2026-09-27): kode audit spesifik untuk recheck manual
-- withdrawal PROCESSING dan reaktivasi voucher.
-- Append-only / additive: hanya menambah nilai enum AuditAction, tanpa
-- mengubah nilai yang sudah ada. Pola sama dengan migrasi
-- 20260927170000_withdrawal_dual_approval_audit.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_RECHECKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'VOUCHER_REACTIVATED';
