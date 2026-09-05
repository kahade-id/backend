import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { safeErrorMessage, startLockRenewal } from '../../../common/utils/background-reliability.util';
import { formatWIBDate } from '../../../common/utils/date.util';

@Injectable()
export class NotificationArchivalService {
  private readonly logger = new Logger(NotificationArchivalService.name);
  private readonly retentionReadDays: number;
  private readonly retentionUnreadDays: number;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
  ) {
    this.retentionReadDays = this.configService.get<number>('app.retentionReadNotificationDays') ?? 30;
    this.retentionUnreadDays = this.configService.get<number>('app.retentionUnreadNotificationDays') ?? 90;
  }

  // SCH-004/SCH-017: Single source of truth for notification lifecycle cleanup.
  // Runs at 10:00 WIB (03:00 UTC) daily.
  @Cron('0 3 * * *', { name: 'notification-archival', timeZone: 'UTC' })
  async archiveOldNotifications(): Promise<void> {
    await cronJitter(30_000);
    if (!(await ensureRedisAvailable(this.redis, 'notification-archival'))) return;

    const today = formatWIBDate();
    const lockKey = `cron_lock:notification_archival:${today}`;
    const lockToken = randomUUID();
    const lockTtlSeconds = 1800;
    const acquired = await this.redis.setNx(lockKey, lockToken, lockTtlSeconds);
    if (!acquired) {
      this.logger.log('Notification archival skipped — another instance already executing.');
      return;
    }

    const lease = startLockRenewal(this.redis, lockKey, lockToken, lockTtlSeconds, this.logger);
    const startedAt = Date.now();
    this.logger.log('Starting notification archival...');
    const now = new Date();
    const readCutoff = new Date(now.getTime() - this.retentionReadDays * 24 * 60 * 60 * 1000);
    const unreadCutoff = new Date(now.getTime() - this.retentionUnreadDays * 24 * 60 * 60 * 1000);

    try {
      const BATCH_SIZE = 1000;
      let totalArchived = 0;
      let batchCount: number;

      do {
        if (lease.lost()) throw new Error('Notification archival lease lost');
        const batch = await this.prisma.notification.findMany({
          where: { createdAt: { lt: readCutoff }, isRead: true },
          select: { id: true },
          take: BATCH_SIZE,
        });
        batchCount = batch.length;
        if (batchCount > 0) {
          await this.prisma.notification.deleteMany({
            where: { id: { in: batch.map(n => n.id) } },
          });
          totalArchived += batchCount;
        }
      } while (batchCount === BATCH_SIZE);

      let unreadBatchCount = 0;
      do {
        if (lease.lost()) throw new Error('Notification archival lease lost');
        const unreadBatch = await this.prisma.notification.findMany({
          where: { createdAt: { lt: unreadCutoff }, isRead: false },
          select: { id: true },
          take: BATCH_SIZE,
        });
        unreadBatchCount = unreadBatch.length;
        if (unreadBatchCount > 0) {
          await this.prisma.notification.deleteMany({ where: { id: { in: unreadBatch.map(n => n.id) } } });
          totalArchived += unreadBatchCount;
        }
      } while (unreadBatchCount === BATCH_SIZE);

      const durationMs = Date.now() - startedAt;
      this.logger.log(`Notification archival completed (${durationMs}ms): ${totalArchived} notifications archived (read cutoff=${this.retentionReadDays}d, unread cutoff=${this.retentionUnreadDays}d).`);

      await this.redis.setex(`cron_heartbeat:notification_archival`, 86400, JSON.stringify({
        ranAt: new Date().toISOString(),
        totalArchived,
        durationMs,
      })).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    } catch (error) {
      const message = safeErrorMessage(error);
      this.logger.error(`Notification archival FAILED: ${message}`);
      throw error;
    } finally {
      lease.stop();
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${safeErrorMessage(err)}`));
    }
  }
}
