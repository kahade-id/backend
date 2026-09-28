-- Alamat pengiriman pada OrderLink (TRX-009 — jalur order link).
-- ADDITIVE-ONLY: satu kolom nullable di tabel "OrderLink".
-- Link yang dibuat pembuat berperan BUYER untuk PHYSICAL_GOODS wajib
-- menyertakan shippingAddressId (ID buku alamat milik pembuat); saat link
-- di-accept, ID ini divalidasi ulang kepemilikannya oleh buyer lalu
-- di-snapshot terenkripsi ke kolom Order.shipping* (migrasi 20261005000000).
-- Link yang dibuat SELLER: alamat diisi penerima (pembeli) via body accept.
-- NULL = link dibuat sebelum fitur ini / bukan barang fisik.
ALTER TABLE "order_links" ADD COLUMN "shippingAddressId" TEXT;
