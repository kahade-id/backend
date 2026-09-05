import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { formatWIBDate } from '../../../common/utils/date.util';

@Injectable()
export class DataCleanupService implements OnModuleInit {
  private readonly logger = new Logger(DataCleanupService.name);
  private readonly retentionExpiredOtpDays: number;
  private readonly retentionWebhookLogDays: number;
  private readonly retentionAnonymizeDays: number;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
  ) {
    this.retentionExpiredOtpDays = this.configService.get<number>('app.retentionExpiredOtpDays') ?? 90;
    this.retentionWebhookLogDays = this.configService.get<number>('app.retentionWebhookLogDays') ?? 90;
    this.retentionAnonymizeDays = this.configService.get<number>('app.retentionAnonymizeDays') ?? 30;
  }

  // Valid bcrypt hash used to replace real passwords on anonymised accounts.
  // Generated at startup from a discarded random plaintext — compare() always returns false.
  private anonymizedPasswordHash!: string;

  async onModuleInit(): Promise<void> {
    // Use cryptographically strong random bytes as the discarded plaintext.
    // Cost factor matches the application default (12); the plaintext is never stored.
    this.anonymizedPasswordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
  }

  // SCH-005/SCH-017: Runs at 03:00 WIB (20:00 UTC) daily for data cleanup
  @Cron('0 20 * * *', { name: 'data-cleanup', timeZone: 'UTC' })
  async cleanupExpiredData(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'data-cleanup'))) return;

    const today = formatWIBDate();
    const lockKey = `cron_lock:data_cleanup:${today}`;
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 1800);
    if (!acquired) {
      this.logger.log('Data cleanup skipped — another instance already executing.');
      return;
    }

    const startedAt = Date.now();
    this.logger.log('Starting expired data cleanup...');
    const now = new Date();
    const anonymizeThreshold = new Date(now.getTime() - this.retentionAnonymizeDays * 24 * 60 * 60 * 1000);

    try {
      // SCH-004: Notification cleanup is handled exclusively by NotificationArchivalService.
      // SCH-005: Retention periods are configurable via env vars.
      const otpRetentionMs = this.retentionExpiredOtpDays * 24 * 60 * 60 * 1000;
      const webhookRetentionMs = this.retentionWebhookLogDays * 24 * 60 * 60 * 1000;

      const deleteOperations: Array<{ name: string; fn: () => Promise<{ count: number }> }> = [
        { name: 'OTP', fn: (): Promise<{ count: number }> => {
          const otpCutoff = new Date(now.getTime() - otpRetentionMs);
          return this.prisma.otpCode.deleteMany({ where: { expiresAt: { lt: otpCutoff } } });
        } },
        { name: 'Sessions', fn: (): Promise<{ count: number }> => this.prisma.userSession.deleteMany({ where: { expiresAt: { lt: now } } }) },
        { name: 'IdempotencyRecords', fn: (): Promise<{ count: number }> => this.prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: now } } }) },
        { name: 'WebhookLogs', fn: (): Promise<{ count: number }> => {
          const webhookCutoff = new Date(now.getTime() - webhookRetentionMs);
          return this.prisma.webhookLog.deleteMany({
            where: {
              createdAt: { lt: webhookCutoff },
              OR: [
                { isProcessed: true },
                { deadLetteredAt: { not: null } },
              ],
            },
          });
        } },
      ];

      const results: Record<string, number> = {};
      for (const op of deleteOperations) {
        try {
          const result = await op.fn();
          results[op.name] = result.count;
        } catch (err) {
          this.logger.error(`Data cleanup sub-task "${op.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
          results[op.name] = -1;
        }
      }

      if (Object.values(results).some(count => count < 0)) {
        throw new Error('One or more data cleanup subtasks failed; heartbeat will not report success');
      }

      // GDPR: anonymize PII for users who soft-deleted their account beyond retention period.
      const anonymizedCount = await this.anonymizeDeletedUsers(anonymizeThreshold);
      results['AnonymizedUsers'] = anonymizedCount;

      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `Data cleanup completed (${durationMs}ms): ` +
        Object.entries(results).map(([k, v]) => `${k}=${v}`).join(', '),
      );

      await this.redis.setex(`cron_heartbeat:data_cleanup`, 86400, JSON.stringify({
        ranAt: new Date().toISOString(),
        results,
        durationMs,
      })).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    } catch (error) {
      this.logger.error('Data cleanup FAILED', error);
      throw error;
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /**
   * Overwrites PII fields for users deleted 30+ days ago (GDPR Article 17).
   * Rows with emails ending in `@kahade.invalid` are already anonymised — skipped.
   */
  private async anonymizeDeletedUsers(deletedBefore: Date): Promise<number> {
    const usersToAnonymize = await this.prisma.user.findMany({
      where: {
        deletedAt: { lt: deletedBefore, not: null },
        email: { not: { endsWith: '@kahade.invalid' } },
      },
      select: { id: true },
      take: 500,
    });

    if (usersToAnonymize.length === 0) return 0;

    const userIds = usersToAnonymize.map(u => u.id);

    const BATCH_SIZE = 50;
    for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
      const batch = userIds.slice(i, i + BATCH_SIZE);
      await this.prisma.$transaction(async (tx) => {
        await Promise.all([
          tx.otpCode.deleteMany({ where: { userId: { in: batch } } }),
          tx.twoFactorAuth.deleteMany({ where: { userId: { in: batch } } }),
          tx.userDevice.updateMany({
            where: { userId: { in: batch } },
            data: { pushToken: null, ipAddress: '0.0.0.0' },
          }),
        ]);

        for (const id of batch) {
          await tx.user.update({
            where: { id },
            data: {
              email: `deleted-${id}@kahade.invalid`,
              fullName: 'Deleted User',
              password: this.anonymizedPasswordHash,
              username: null,
              bio: null,
              avatarUrl: null,
              headerUrl: null,
              phoneNumber: 'DELETED',
              dateOfBirth: null,
              gender: null,
              contactEmail: null,
              contactPhone: null,
              usernameChangedAt: null,
              lastLoginIp: null,
              banReason: null,
            },
          });
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    }

    return userIds.length;
  }
}
