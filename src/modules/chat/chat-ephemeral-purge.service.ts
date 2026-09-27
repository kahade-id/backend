import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

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

    const ids = toPurge.map((c) => c.id);
    // Hard delete: pesan ephemeral memang dirancang untuk hilang. Lampiran,
    // reaksi, riwayat edit, dan bintang ikut terhapus via onDelete: Cascade.
    const result = await this.prisma.chatMessage.deleteMany({ where: { id: { in: ids } } });

    // Beri tahu klien yang sedang membuka room agar menghapus bubble-nya.
    const byRoom = new Map<string, string[]>();
    for (const c of toPurge) {
      const list = byRoom.get(c.roomId) ?? [];
      list.push(c.id);
      byRoom.set(c.roomId, list);
    }
    for (const [roomId, messageIds] of byRoom) {
      this.realtime.emitToChatRoom(roomId, 'chat.messages_expired', { roomId, messageIds });
    }

    if (skippedDisputed > 0) {
      this.logger.log(`Ephemeral purge: ${result.count} purged, ${skippedDisputed} skipped (disputed orders)`);
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
