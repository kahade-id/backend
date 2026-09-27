-- BE-IMP batch (2026-09-28) — TIM BE-IMP mega-batch Kahade.
-- ADDITIVE-ONLY: hanya ADD COLUMN (nullable / ber-default). Tidak ada
-- ALTER/DROP kolom existing, tidak ada perubahan nilai enum existing.
-- Aman untuk data produksi. TIDAK dijalankan ke database production dari sini.

-- ── Item 130: lampiran pada balasan tiket support ─────────────────────
-- SupportTicketReply.attachments (JSONB, default []) — mirror kolom
-- attachments milik SupportTicket. Balasan lama otomatis terisi [].
ALTER TABLE "support_ticket_replies"
  ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]';
