import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { safeErrorMessage } from '../../../common/utils/background-reliability.util';
import { AdminFeedbackService } from '../../admin/feedback/admin-feedback.service';

/**
 * G165: redaksi kontak guest (> 90 hari) — berjalan harian 02:00 WIB.
 * Delegasi ke AdminFeedbackService.redactExpiredGuestContacts() (satu sumber logika).
 */
@Injectable()
export class FeedbackGuestContactRedactionService {
  private readonly logger = new Logger(FeedbackGuestContactRedactionService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private adminFeedback: AdminFeedbackService,
  ) {}

  @Cron('0 2 * * *', { name: 'feedback-guest-contact-redaction', timeZone: 'Asia/Jakarta' })
  async redactExpiredGuestContacts(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'feedback-guest-contact-redaction'))) return;

    const lockKey = 'cron_lock:feedback_guest_contact_redaction';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 1800);
    if (!acquired) {
      this.logger.log('Feedback guest contact redaction skipped — another instance already executing.');
      return;
    }

    try {
      const { redacted } = await this.adminFeedback.redactExpiredGuestContacts();
      this.logger.log(`Feedback guest contact redaction selesai: ${redacted} kontak diredaksi.`);
    } catch (error) {
      this.logger.error(`Feedback guest contact redaction gagal: ${safeErrorMessage(error)}`);
      throw error;
    } finally {
      await this.redis.del(lockKey).catch(() => undefined);
    }
  }
}
