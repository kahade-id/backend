import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { UploadService } from '../upload/upload.service';

/**
 * Batch 43 BE-CHAT: worker purge pesan sementara (ephemeral) & sekali lihat.
 *
 * Setiap menit menghapus PERMANEN pesan yang sudah kedaluwarsa
 * (`expiresAt < now()`). Fail-safe bukti sengketa: pesan di room yang order-nya
 * sedang DISPUTED dilewati (tidak dihapus) — konsisten dengan prinsip
 * "pesan masa sengketa tidak boleh hilang" di modul chat.
 *
 * Pesan sekali-lihat (viewOnce) yang sudah dibaca diberi expiresAt =
 * dibaca + CHAT_VIEW_ONCE_GRACE_SECONDS oleh ChatService.getMessages.
 */
@Injectable()
export class ChatEphemeralPurgeService {
  private readonly logger = new Logger(ChatEphemeralPurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly uploadService: UploadService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async purgeExpiredMessages(): Promise<{ purged: number; skippedDisputed: number }> {
    return this.purgeExpiredMessagesWithLimit(500);
  }

  private async purgeExpiredMessagesWithLimit(limit: number): Promise<{ purged: number; skippedDisputed: number }> {
    const safeLimit = Math.max(1, Math.min(2000, Math.trunc(limit) || 500));
    // Kumpulkan kandidat kedaluwarsa beserta info sengketa order-nya.
    const candidates = await this.prisma.chatMessage.findMany({
      where: { expiresAt: { lt: new Date() }, isDeleted: false },
      select: {
        id: true,
        roomId: true,
        room: { select: { order: { select: { status: true } } } },
      },
      take: safeLimit,
    });

    const toPurge = candidates.filter((c) => c.room?.order?.status !== 'DISPUTED');
    const skippedDisputed = candidates.length - toPurge.length;

    if (toPurge.length === 0) {
      return { purged: 0, skippedDisputed };
    }

    // LOW (SEC-D): hapus file fisik lampiran DULU (pola SS-014) — tabel
    // chat_attachments tidak menyimpan fileKey, jadi ekstrak dari URL
    // tersimpan (publik/signed). Pesan yang file-nya gagal dihapus dilewati
    // (retry menit berikutnya) agar tidak ada file yatim di disk.
    const purgeIds = toPurge.map((c) => c.id);
    const attachments = await this.prisma.chatAttachment.findMany({
      where: { messageId: { in: purgeIds } },
      select: { messageId: true, fileUrl: true, thumbnailUrl: true },
    });
    const filesByMessage = new Map<string, string[]>();
    for (const att of attachments) {
      const keys = [att.fileUrl, att.thumbnailUrl]
        .map((url) => (url ? this.uploadService.fileKeyFromStoredUrl(url) : null))
        .filter((k): k is string => !!k);
      if (keys.length > 0) filesByMessage.set(att.messageId, [...(filesByMessage.get(att.messageId) ?? []), ...keys]);
    }
    const ids: string[] = [];
    for (const c of toPurge) {
      const keys = filesByMessage.get(c.id) ?? [];
      let filesOk = true;
      for (const key of new Set(keys)) {
        const deleted = await this.uploadService.deleteStoredFile(key).catch(() => false);
        if (!deleted) {
          this.logger.error(
            `[SECURITY] Gagal hapus file lampiran ${key} untuk pesan ephemeral ${c.id} — pesan dipertahankan untuk retry`,
          );
          filesOk = false;
        }
      }
      if (filesOk) ids.push(c.id);
    }
    const skippedFiles = toPurge.length - ids.length;
    if (ids.length === 0) {
      return { purged: 0, skippedDisputed };
    }
    // Hard delete: pesan ephemeral memang dirancang untuk hilang. Lampiran,
    // reaksi, riwayat edit, dan bintang ikut terhapus via onDelete: Cascade.
    const result = await this.prisma.chatMessage.deleteMany({ where: { id: { in: ids } } });

    // Beri tahu klien yang sedang membuka room agar menghapus bubble-nya.
    // Hanya untuk pesan yang benar-benar ter-purge (bukan yang diskip karena
    // file gagal dihapus).
    const roomById = new Map(toPurge.map((c) => [c.id, c.roomId]));
    const byRoom = new Map<string, string[]>();
    for (const id of ids) {
      const roomId = roomById.get(id);
      if (!roomId) continue;
      const list = byRoom.get(roomId) ?? [];
      list.push(id);
      byRoom.set(roomId, list);
    }
    for (const [roomId, messageIds] of byRoom) {
      this.realtime.emitToChatRoom(roomId, 'chat.messages_expired', { roomId, messageIds });
    }

    if (skippedDisputed > 0 || skippedFiles > 0) {
      this.logger.log(
        `Ephemeral purge: ${result.count} purged, ${skippedDisputed} skipped (disputed orders), ${skippedFiles} skipped (file cleanup gagal, retry berikutnya)`,
      );
    }
    return { purged: result.count, skippedDisputed };
  }

  /**
   * Dipakai test & admin: purge satu batch tanpa menunggu cron.
   * (Tidak mengubah perilaku cron di atas.)
   */
  async purgeNow(limit = 500): Promise<{ purged: number; skippedDisputed: number }> {
    return this.purgeExpiredMessagesWithLimit(limit);
  }
}
