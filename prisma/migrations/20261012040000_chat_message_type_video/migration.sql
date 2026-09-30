-- NCC-009: tambah VIDEO ke enum ChatMessageType (ADDITIVE — ALTER TYPE ADD VALUE).
-- DTO send-message (UserChatMessageType) sudah mengizinkan VIDEO; tanpa nilai
-- ini pesan video lolos validasi lalu gagal 500 saat write ke DB.
ALTER TYPE "ChatMessageType" ADD VALUE IF NOT EXISTS 'VIDEO';
