-- Deferred audit Wallet #2: kode stabil untuk alasan penguncian wallet.
-- lockReason tetap menyimpan detail operasional (EN) untuk rekonsiliasi;
-- kolom baru ini yang dipetakan ke i18n di klien/admin.
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "lockReasonCode" TEXT;
