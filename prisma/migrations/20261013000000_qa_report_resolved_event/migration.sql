-- BAI-027 (audit integrasi 2026-09-30): nilai event baru agar resolusi
-- laporan QA (DISMISSED / ACTION_TAKEN) tercatat di qa_moderation_events
-- beserta catatan internal resolusi — sebelumnya `note` dibuang backend
-- (`void note`) walau kontrak DTO+UI admin mendukungnya.
ALTER TYPE "qa_event_action" ADD VALUE IF NOT EXISTS 'REPORT_RESOLVED';
