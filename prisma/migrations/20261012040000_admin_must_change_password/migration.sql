-- AUT-011: flag wajib-ganti-password untuk admin (login pertama / pasca-reset).
-- Kolom aditif dengan default false — admin yang sudah ada tidak terdampak.
ALTER TABLE "admin_users" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
