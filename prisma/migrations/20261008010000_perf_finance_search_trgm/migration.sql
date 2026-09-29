-- AW-003 (perf-fix): indeks trigram untuk pencarian transaksi keuangan admin.
--
-- Backend membangun `where.OR` dengan 7 kondisi `contains` (txId, description,
-- order.orderId, paymentTx.midtransOrderId, paymentTx.flashTransactionId,
-- irisPayoutId, irisRef). Pola LIKE '%...%' / ILIKE '%...%' tidak bisa memakai
-- indeks B-tree biasa, sehingga tiap pencarian = sequential scan. Indeks GIN
-- pg_trgm membuat pencarian substring tetap cepat seiring tabel tumbuh.
--
-- Additive-only: hanya CREATE EXTENSION + CREATE INDEX IF NOT EXISTS.
-- Tidak mengubah kolom/tabel/data apa pun. Aman di-rerun.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Kolom langsung di wallet_transactions (4 dari 7 cabang OR).
-- CATATAN: kolom memakai camelCase (Prisma tanpa @map) — wajib double-quote.
CREATE INDEX IF NOT EXISTS wallet_transactions_tx_id_trgm
  ON wallet_transactions USING gin ("txId" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS wallet_transactions_description_trgm
  ON wallet_transactions USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS wallet_transactions_iris_payout_id_trgm
  ON wallet_transactions USING gin ("irisPayoutId" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS wallet_transactions_iris_ref_trgm
  ON wallet_transactions USING gin ("irisRef" gin_trgm_ops);

-- Kolom relasi di 3 cabang OR sisanya (join ke orders / payment_transactions).
CREATE INDEX IF NOT EXISTS orders_order_id_trgm
  ON orders USING gin ("orderId" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS payment_transactions_midtrans_order_id_trgm
  ON payment_transactions USING gin ("midtransOrderId" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS payment_transactions_flash_transaction_id_trgm
  ON payment_transactions USING gin ("flashTransactionId" gin_trgm_ops);
