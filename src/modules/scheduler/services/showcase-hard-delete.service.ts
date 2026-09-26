import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { UploadService } from '../../upload/upload.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { formatWIBDate } from '../../../common/utils/date.util';
import { safeErrorMessage } from '../../../common/utils/background-reliability.util';

/**
 * Hard delete permanen untuk item showcase yang sudah di-soft-delete
 * lebih dari 30 hari. Berjalan sekali sehari jam 03:00 WIB.
 *
 * Alur: user hapus etalase → deletedAt di-set (soft delete, bisa
 * dipulihkan 30 hari) → cron ini bersihkan file storage DULU lalu hard delete
 * baris DB. Bila cleanup gagal, baris DB dipertahankan untuk retry jalan
 * berikutnya (tidak ada file yatim).
 */
@Injectable()
export class ShowcaseHardDeleteService {
  private readonly logger = new Logger(ShowcaseHardDeleteService.name);
  private static readonly RETENTION_DAYS = 30;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private uploadService: UploadService,
  ) {}

  // Berjalan jam 03:00 WIB (20:00 UTC hari sebelumnya) setiap hari.
  @Cron('0 20 * * *', { name: 'showcase-hard-delete', timeZone: 'UTC' })
  async hardDeleteExpiredShowcases(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'showcase-hard-delete'))) return;

    const today = formatWIBDate();
    const lockKey = `cron_lock:showcase_hard_delete:${today}`;
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 1800);
    if (!acquired) {
      this.logger.log('Showcase hard delete skipped — another instance already executing.');
      return;
    }

    const cutoff = new Date(Date.now() - ShowcaseHardDeleteService.RETENTION_DAYS * 24 * 60 * 60 * 1000);
    this.logger.log(`Starting showcase hard delete (deletedAt < ${cutoff.toISOString()})...`);

    // SS-013: loop batch sampai tidak ada lagi item kedaluwarsa (bukan cuma
    // 500 pertama). Batas aman per jalan agar satu run tidak berjalan selamanya.
    const BATCH_SIZE = 500;
    const MAX_PER_RUN = 5000;
    let deleted = 0;
    let skipped = 0;
    let processed = 0;

    try {
      for (;;) {
        const expired = await this.prisma.userShowcase.findMany({
          where: { deletedAt: { lt: cutoff } },
          select: {
            id: true,
            userId: true,
            images: { select: { fileKey: true } },
          },
          take: BATCH_SIZE,
          orderBy: { deletedAt: 'asc' },
        });
        if (expired.length === 0) break;

        for (const item of expired) {
          processed++;
          try {
            // SS-014: bersihkan storage DULU, baru hapus baris DB.
            // Bila cleanup gagal, baris DB dipertahankan → retry di jalan
            // berikutnya (tidak ada file yatim tanpa catatan).
            const fileKeys = item.images.map((img) => img.fileKey).filter((k): k is string => Boolean(k));
            if (fileKeys.length > 0) {
              const result = await this.uploadService.cleanupFileKeys(item.userId, fileKeys);
              if (result.errors.length > 0) {
                this.logger.error(
                  `Storage cleanup gagal untuk showcase ${item.id} — baris DB dipertahankan untuk retry: ` +
                  result.errors.map((e) => `${e.fileKey}: ${e.reason}`).join('; '),
                );
                skipped++;
                continue;
              }
            }
            // Hard delete: cascade hapus likes, comments, images, reports.
            await this.prisma.userShowcase.delete({ where: { id: item.id } });
            deleted++;
          } catch (err) {
            this.logger.error(`Failed to hard delete showcase ${item.id}: ${safeErrorMessage(err)}`);
            skipped++;
          }
        }

        if (processed >= MAX_PER_RUN) {
          this.logger.warn(`Showcase hard delete mencapai batas ${MAX_PER_RUN} item/jalan — sisa dilanjut besok.`);
          break;
        }
      }

      this.logger.log(`Showcase hard delete selesai: ${deleted} dihapus permanen, ${skipped} dilewati (retry berikutnya).`);
    } catch (err) {
      this.logger.error(`Showcase hard delete gagal: ${safeErrorMessage(err)}`);
    }
  }
}
