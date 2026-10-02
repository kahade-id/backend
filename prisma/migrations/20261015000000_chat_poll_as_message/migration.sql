-- Polling sebagai pesan chat (ADDITIVE).
-- 1) Tambah nilai POLL ke enum ChatMessageType.
-- 2) Tambah kolom pollId (nullable) di chat_messages + FK ke chat_polls
--    ON DELETE SET NULL: penghapusan poll tidak menghapus baris pesannya.
ALTER TYPE "ChatMessageType" ADD VALUE IF NOT EXISTS 'POLL';
ALTER TABLE "chat_messages" ADD COLUMN "pollId" TEXT;
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "chat_polls"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "chat_messages_pollId_idx" ON "chat_messages"("pollId");
