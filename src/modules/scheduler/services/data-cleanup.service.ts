import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { Prisma, DeletionRequestStatus, NotificationType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { formatWIBDate } from '../../../common/utils/date.util';
import { DELETION_PURGE_LOCK } from '../../../common/constants/redis-keys';
import { generateNotifId } from '../../../common/utils/id-generator.util';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { EMAIL_QUEUE, EmailJobData } from '../../queue/processors/email.processor';
import { decryptPiiSafe } from '../../../common/utils/pii.util';
// GAP-A (G058/G059): kanal WhatsApp untuk pengingat penghapusan.
// @Optional: SchedulerModule tidak mengimpor AuthModule — bila gateway tidak
// tersedia, pengingat WhatsApp dilewati (in-app + email tetap jalan) dan
// dicatat di log. Ini degradasi notifikasi, BUKAN gerbang keamanan.
import { OtpGatewayService } from '../../auth/otp-gateway.service';
import {
  generateDeletionReferenceCode,
  computePurgeAt,
  ACTIVE_DELETION_STATUSES,
} from '../../users/account-deletion.service';

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
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailJobData>,
    // GAP-A (G058/G059): @Optional — SchedulerModule tidak mengimpor AuthModule.
    @Optional() private readonly otpGateway?: OtpGatewayService,
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

      // GAP-A (G058/G059): pengingat H-7 & H-1 untuk permintaan penghapusan aktif.
      const reminderCounts = await this.processDeletionReminders().catch((err) => {
        this.logger.error(`Deletion reminders failed: ${err instanceof Error ? err.message : String(err)}`);
        return { sent7d: -1, sent1d: -1 };
      });
      results['DeletionReminders7d'] = reminderCounts.sent7d;
      results['DeletionReminders1d'] = reminderCounts.sent1d;

      // GAP-A (G056/G073): purge permanen request yang masa tenggangnya berakhir.
      const purgedCount = await this.purgeDueDeletionRequests().catch((err) => {
        this.logger.error(`Deletion purge failed: ${err instanceof Error ? err.message : String(err)}`);
        return -1;
      });
      results['DeletionPurged'] = purgedCount;

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
   * GAP-A (G058/G059): pengingat H-7 & H-1 untuk permintaan penghapusan aktif.
   * Dijalankan dari cron harian. In-app notification selalu dibuat — jalur yang
   * tetap bisa diterima walau push token sudah dinonaktifkan (G059); email
   * dikirim bila alamat tersedia (best-effort).
   */
  private async processDeletionReminders(): Promise<{ sent7d: number; sent1d: number }> {
    const now = new Date();
    const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const in1d = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);
    // Satu sumber kebenaran status aktif (GAP-A): lihat ACTIVE_DELETION_STATUSES.
    const active: DeletionRequestStatus[] = ACTIVE_DELETION_STATUSES;

    const due7d = await this.prisma.accountDeletionRequest.findMany({
      where: { status: { in: active }, reminder7dSent: false, purgeAt: { lte: in7d, gt: now } },
      select: { id: true, userId: true, referenceCode: true, purgeAt: true },
      take: 500,
    });
    const due1d = await this.prisma.accountDeletionRequest.findMany({
      where: { status: { in: active }, reminder1dSent: false, purgeAt: { lte: in1d, gt: now } },
      select: { id: true, userId: true, referenceCode: true, purgeAt: true },
      take: 500,
    });

    let sent7d = 0;
    let sent1d = 0;
    for (const req of due7d) {
      if (await this.sendDeletionReminder(req, 7)) sent7d += 1;
    }
    for (const req of due1d) {
      // Hindari pengingat ganda bila H-7 dan H-1 jatuh di hari yang sama.
      if (due7d.some((r) => r.id === req.id) && req.purgeAt.getTime() - now.getTime() > 24 * 60 * 60 * 1000) continue;
      if (await this.sendDeletionReminder(req, 1)) sent1d += 1;
    }
    return { sent7d, sent1d };
  }

  private async sendDeletionReminder(
    req: { id: string; userId: string; referenceCode: string; purgeAt: Date },
    daysLeft: 7 | 1,
  ): Promise<boolean> {
    const lockKey = `deletion_reminder:${req.id}:${daysLeft}d`;
    const token = randomUUID();
    const acquired = await this.redis.setNx(lockKey, token, 3600).catch(() => false);
    if (!acquired) return false;
    try {
      const flagField = daysLeft === 7 ? 'reminder7dSent' : 'reminder1dSent';
      const current = await this.prisma.accountDeletionRequest.findUnique({
        where: { id: req.id },
        select: { status: true, reminder7dSent: true, reminder1dSent: true },
      });
      const stillActive =
        current &&
        ACTIVE_DELETION_STATUSES.includes(current.status);
      if (!stillActive || current[flagField]) return false;

      const purgeDate = req.purgeAt.toLocaleDateString('id-ID', {
        day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta',
      });
      const title = daysLeft === 7 ? 'Akun Anda akan dihapus dalam 7 hari' : 'Akun Anda akan dihapus besok';
      const body =
        `Kode referensi: ${req.referenceCode}. ` +
        `Akun Anda akan dihapus permanen pada ${purgeDate}. ` +
        `Masih bisa dibatalkan: buka aplikasi Kahade → Masuk → "Akun dihapus? Pulihkan di sini".`;

      // G059: in-app record selalu dibuat — tetap terbaca walau push mati.
      const type = NotificationType.SYSTEM_ANNOUNCEMENT;
      await this.prisma.notification.create({
        data: {
          notifId: generateNotifId(),
          userId: req.userId,
          type,
          category: getCategoryForType(type),
          title,
          body,
          isRead: false,
          refType: 'ACCOUNT_DELETION',
          refId: req.referenceCode,
        },
      });

      const user = await this.prisma.user.findUnique({
        where: { id: req.userId },
        select: { email: true, phoneNumber: true, phoneVerified: true },
      });
      if (user?.email) {
        await this.emailQueue
          .add(
            'send',
            { to: user.email, subject: `Kahade — ${title}`, text: `${title}.\n\n${body}` } as EmailJobData,
            { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 100, removeOnFail: 50 },
          )
          .catch((err) => this.logger.warn(`[deletion] reminder email failed: ${err instanceof Error ? err.message : String(err)}`));
      }

      // GAP-A (G058/G059): WhatsApp — kanal yang dijamin sampai. User dalam
      // masa tenggang sudah kehilangan sesi & push token, dan bisa tidak
      // punya email (registrasi phone-only). Best-effort: kegagalan kirim
      // tidak menggagalkan flag pengingat (in-app record sudah dibuat).
      // BUKAN jalur OTP — OTP tetap hanya via alur trigger user-initiated.
      if (user?.phoneVerified && this.otpGateway) {
        const phone = await decryptPiiSafe(user.phoneNumber).catch(() => null);
        if (phone) {
          const waText =
            `Kahade: ${title}.\n` +
            `Kode referensi: ${req.referenceCode}. Akun Anda dihapus permanen pada ${purgeDate}. ` +
            `Untuk membatalkan, buka aplikasi Kahade → Masuk → "Akun dihapus? Pulihkan di sini".`;
          await this.otpGateway
            .sendTextMessage(phone, waText)
            .then((res) => {
              if (!res.success) {
                this.logger.warn(`[deletion] reminder WhatsApp failed for ${req.id}: ${res.error ?? 'unknown'}`);
              }
            })
            .catch((err) =>
              this.logger.warn(`[deletion] reminder WhatsApp error for ${req.id}: ${err instanceof Error ? err.message : String(err)}`),
            );
        }
      } else if (!this.otpGateway) {
        this.logger.warn('[deletion] OtpGatewayService unavailable — WhatsApp reminder skipped (in-app + email tetap jalan).');
      }

      await this.prisma.accountDeletionRequest.update({ where: { id: req.id }, data: { [flagField]: true } });
      return true;
    } catch (err) {
      this.logger.warn(`[deletion] reminder failed for ${req.id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      await this.redis.releaseLock(lockKey, token).catch(() => undefined);
    }
  }

  /**
   * GAP-A (G056/G073): purge permanen permintaan penghapusan yang masa
   * tenggang 30 harinya berakhir.
   *
   * - Kunci Redis per-user (G073): dua worker tidak memproses user yang sama.
   * - Status TERBARU dibaca di dalam transaksi Serializable tepat sebelum
   *   purge (G056): request yang sudah CANCELLED/ON_HOLD tidak ikut terpurge.
   * - Menandai PURGED + riwayat append-only (G062) + anonimkan baris user.
   */
  private async purgeDueDeletionRequests(): Promise<number> {
    const now = new Date();
    const due = await this.prisma.accountDeletionRequest.findMany({
      where: {
        status: { in: ACTIVE_DELETION_STATUSES },
        purgeAt: { lte: now },
      },
      select: { id: true, userId: true },
      take: 500,
    });

    let purged = 0;
    for (const req of due) {
      const lockKey = DELETION_PURGE_LOCK(req.userId);
      const token = randomUUID();
      const acquired = await this.redis.setNx(lockKey, token, 600).catch(() => false);
      if (!acquired) {
        this.logger.warn(`[deletion] purge skipped for ${req.id}: lock held by another worker`);
        continue;
      }
      try {
        const done = await this.prisma.$transaction(
          async (tx) => {
            // G056: baca status terbaru — pembatalan/ON_HOLD detik terakhir menang.
            const current = await tx.accountDeletionRequest.findUnique({ where: { id: req.id } });
            const purgeable =
              current &&
              ACTIVE_DELETION_STATUSES.includes(current.status) &&
              current.purgeAt <= new Date();
            if (!purgeable) return false;

            const purgedAt = new Date();
            await tx.accountDeletionRequest.update({
              where: { id: req.id },
              data: { status: DeletionRequestStatus.PURGED, purgedAt },
            });
            // G062: riwayat append-only.
            await tx.accountDeletionStatusHistory.create({
              data: {
                requestId: req.id,
                fromStatus: current.status,
                toStatus: DeletionRequestStatus.PURGED,
                actorType: 'SYSTEM',
                reason: 'Masa tenggang 30 hari berakhir',
              },
            });
            // Anonimkan PII baris user (data retensi finansial/hukum tetap ada
            // di tabel transaksional sesuai kebijakan retensi).
            await tx.user.update({
              where: { id: req.userId },
              data: {
                email: `deleted-${req.userId}@kahade.invalid`,
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
            return true;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        if (done) purged += 1;
      } catch (err) {
        this.logger.error(`[deletion] purge failed for ${req.id}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await this.redis.releaseLock(lockKey, token).catch(() => undefined);
      }
    }
    return purged;
  }

  /**
   * Overwrites PII fields for users deleted 30+ days ago (GDPR Article 17).
   * Rows with emails ending in `@kahade.invalid` are already anonymised — skipped.
   *
   * GAP-A (G069): LEGACY path — hanya untuk user TANPA request penghapusan
   * aktif. User dengan AccountDeletionRequest non-terminal (PENDING/
   * REQUESTED/ON_HOLD) DIKECUALIKAN: purge mereka hanya lewat jalur
   * request-driven (processDueDeletions) yang mengecek legal hold,
   * blocker saldo/order/dispute, dan reminder. Anonimisasi legal-hold
   * sebelum masanya = pelanggaran.
   */
  private async anonymizeDeletedUsers(deletedBefore: Date): Promise<number> {
    const usersToAnonymize = await this.prisma.user.findMany({
      where: {
        deletedAt: { lt: deletedBefore, not: null },
        email: { not: { endsWith: '@kahade.invalid' } },
        accountDeletionRequests: {
          none: {
            status: {
              in: [
                DeletionRequestStatus.PENDING,
                DeletionRequestStatus.REQUESTED,
                DeletionRequestStatus.ON_HOLD,
              ],
            },
          },
        },
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
