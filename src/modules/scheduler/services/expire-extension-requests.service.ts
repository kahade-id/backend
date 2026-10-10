import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { isCronJobDisabled } from '../../../common/utils/cron-gate.util';
import { DeadlineExtensionStatus } from '@prisma/client';

@Injectable()
export class ExpireExtensionRequestsService {
  private readonly logger = new Logger(ExpireExtensionRequestsService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  // Run every 10 minutes
  // CW-017: beri nama agar terdaftar stabil di SchedulerRegistry/health.
  @Cron('*/10 * * * *', { name: 'expire-extension-requests' })
  async handleExpireExtensionRequests(): Promise<void> {
    // K8 (audit 2026-10-10): lock Redis (sebelumnya tanpa lock — tiap replika
    // menjalankan job yang sama) + feature-flag CRON_DISABLED_JOBS.
    if (isCronJobDisabled('expire-extension-requests')) return;
    if (!(await ensureRedisAvailable(this.redis, 'expire-extension-requests'))) return;
    const lockKey = 'cron_lock:expire_extension_requests';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 300);
    if (!acquired) return;
    try {
      await this.expireDue();
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch((err) =>
        this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  private async expireDue(): Promise<void> {
    try {
      const now = new Date();
      const expired = await this.prisma.orderExtensionRequest.findMany({
        where: {
          status: DeadlineExtensionStatus.PENDING,
          expiresAt: { lt: now },
        },
        select: { id: true, orderId: true },
        take: 100,
      });

      if (expired.length === 0) return;

      for (const req of expired) {
        try {
          await this.prisma.orderExtensionRequest.update({
            where: { id: req.id },
            data: { status: DeadlineExtensionStatus.EXPIRED },
          });
          this.logger.log(`Extension request ${req.id} expired`);
        } catch (e) {
          this.logger.warn(`Failed to expire extension ${req.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to expire extension requests: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined);
    }
  }
}
