-- Tabel laporan user terhadap item showcase (Etalase).
-- Satu user hanya boleh melaporkan satu item sekali (unique constraint).
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'SHOWCASE_REPORTED';

CREATE TABLE "showcase_reports" (
    "id" TEXT NOT NULL,
    "showcaseId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" VARCHAR(100) NOT NULL,
    "description" VARCHAR(1000),
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "showcase_reports_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "showcase_reports" ADD CONSTRAINT "showcase_reports_showcaseId_fkey" FOREIGN KEY ("showcaseId") REFERENCES "user_showcases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "showcase_reports" ADD CONSTRAINT "showcase_reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "showcase_reports_showcaseId_reporterId_key" ON "showcase_reports"("showcaseId", "reporterId");
CREATE INDEX "showcase_reports_status_idx" ON "showcase_reports"("status");
CREATE INDEX "showcase_reports_showcaseId_idx" ON "showcase_reports"("showcaseId");
CREATE INDEX "showcase_reports_reporterId_idx" ON "showcase_reports"("reporterId");
