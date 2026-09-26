-- 03-#6 (Batch 1C): simpan documentType & livenessFileKey di kyc_requests.
-- Sebelumnya dihitung/divalidasi di service tetapi tidak disimpan.

ALTER TABLE "kyc_requests" ADD COLUMN "documentType" TEXT;
ALTER TABLE "kyc_requests" ADD COLUMN "livenessFileKey" TEXT;
