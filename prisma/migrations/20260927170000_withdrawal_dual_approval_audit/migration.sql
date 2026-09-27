-- ADM-205 (2026-09-27): kode audit spesifik untuk dual approval withdrawal.
-- Append-only / additive: hanya menambah nilai enum AuditAction, tanpa
-- mengubah nilai yang sudah ada. Tanpa nilai ini, approval withdrawal tidak
-- bisa dicatat sebagai baris audit ber-tipe sehingga kuorum dual control
-- tidak dapat diverifikasi server-side.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_REJECTED';
