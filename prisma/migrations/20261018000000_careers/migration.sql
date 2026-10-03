-- Karir karir.kahade.id — Fase 1.1: lowongan + lamaran + riwayat status.
-- Konvensi tabel baru: kolom camelCase TANPA @map (lihat schema.prisma),
-- nama tabel snake_case via @@map. Timestamp > 20261017000001 (migrasi terakhir).

-- Status pipeline lamaran
CREATE TYPE "JobApplicationStatus" AS ENUM ('BARU', 'DIREVIEW', 'WAWANCARA', 'DITERIMA', 'DITOLAK');

-- Lowongan pekerjaan
CREATE TABLE "job_postings" (
    "id" TEXT NOT NULL,
    "slug" VARCHAR(128) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "location" VARCHAR(128) NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "equity" VARCHAR(128) NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "requirements" JSONB NOT NULL DEFAULT '[]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_postings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "job_postings_slug_key" ON "job_postings"("slug");
CREATE INDEX "job_postings_isActive_sortOrder_idx" ON "job_postings"("isActive", "sortOrder");

-- Lamaran (PII pelamar). SENGAJA tanpa @@unique([postingId, email]):
-- pelamar DITOLAK boleh melamar lagi posisi yang sama (keputusan user 3 Okt 2026).
-- Duplikat aktif dicegah di service (409 ALREADY_APPLIED bila status bukan DITOLAK).
CREATE TABLE "job_applications" (
    "id" TEXT NOT NULL,
    "postingId" TEXT NOT NULL,
    "fullName" VARCHAR(200) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "coverNote" TEXT,
    "cvFileKey" VARCHAR(512) NOT NULL,
    "portfolioUrl" VARCHAR(512),
    "status" "JobApplicationStatus" NOT NULL DEFAULT 'BARU',
    "internalNote" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "deletionTokenHash" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_applications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "job_applications_postingId_status_idx" ON "job_applications"("postingId", "status");
CREATE INDEX "job_applications_status_updatedAt_idx" ON "job_applications"("status", "updatedAt");

-- Audit trail perubahan status lamaran
CREATE TABLE "job_application_status_history" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "fromStatus" "JobApplicationStatus",
    "toStatus" "JobApplicationStatus" NOT NULL,
    "changedBy" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_application_status_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "job_application_status_history_applicationId_idx" ON "job_application_status_history"("applicationId");

ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_postingId_fkey" FOREIGN KEY ("postingId") REFERENCES "job_postings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "job_application_status_history" ADD CONSTRAINT "job_application_status_history_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "job_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
