-- ADM-228: aksi audit spesifik untuk pembukaan kembali temuan rekonsiliasi
-- (additive-only: menambah nilai enum, tidak mengubah/menghapus yang ada).
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RECONCILIATION_FINDING_REOPENED';
