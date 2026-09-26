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
 * dipulihkan 30 hari) → cron ini hard delete + bersihkan gambar R2.
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

    try {
      // Ambil batch kecil agar tidak membebani DB bila banyak.
      const expired = await this.prisma.userShowcase.findMany({
        where: { deletedAt: { lt: cutoff } },
        select: {
          id: true,
          userId: true,
          images: { select: { fileKey: true } },
        },
        take: 500,
        orderBy: { deletedAt: 'asc' },
      });

      let deleted = 0;
      for (const item of expired) {
        try {
          // Hard delete: cascade hapus likes, comments, images, reports.
          await this.prisma.userShowcase.delete({ where: { id: item.id } });
          const fileKeys = item.images.map((img) => img.fileKey).filter((k): k is string => Boolean(k));
          if (fileKeys.length > 0) {
            await this.uploadService.cleanupFileKeys(item.userId, fileKeys).catch((err) => {
              this.logger.warn(`R2 cleanup failed for showcase ${item.id}: ${safeErrorMessage(err)}`);
            });
          }
          deleted++;
        } catch (err) {
          this.logger.warn(`Failed to hard delete showcase ${item.id}: ${safeErrorMessage(err)}`);
        }
      }

      this.logger.log(`Showcase hard delete selesai: ${deleted}/${expired.length} item dihapus permanen.`);
    } catch (err) {
      this.logger.error(`Showcase hard delete gagal: ${safeErrorMessage(err)}`);
    }
  }
}
