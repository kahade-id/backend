-- FIX QA (2026-09-28): cegah link-order ganda patungan/jastip.
-- ADDITIVE-ONLY: hanya menambah UNIQUE constraint (bukan menghapus/mengubah
-- kolom). NULL tetap diizinkan ganda oleh Postgres (peserta yang order-nya
-- belum ditautkan), jadi aman untuk data existing — constraint hanya melarang
-- satu orderId yang SAMA ditautkan ke 2 peserta (mencegah TARGET_REACHED /
-- pelunasan palsu).
--
-- Constraint names mengikuti konvensi Prisma untuk @@unique([orderId]):
--   "<mapped_table>_orderId_key"

-- PatunganParticipant (patungan_participants.orderId)
ALTER TABLE "patungan_participants" ADD CONSTRAINT "patungan_participants_orderId_key" UNIQUE ("orderId");

-- JastipParticipant (jastip_participants.orderId)
ALTER TABLE "jastip_participants" ADD CONSTRAINT "jastip_participants_orderId_key" UNIQUE ("orderId");
