import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { escapeHtml } from '../../../common/utils/sanitize.util';

const JOB_NAME = 'unanswered-question-reminders';
const LOCK_KEY = 'cron_lock:unanswered_question_reminders';
const LOCK_TTL_SECONDS = 900;

/** Section 4: pertanyaan yang menganggur lebih dari ini dikabari ke pemilik profil. */
export const UNANSWERED_REMINDER_HOURS = 48;

/** Batas baris per tick supaya satu run tidak membanjiri queue notifikasi. */
const BATCH_SIZE = 200;

/** Panjang cuplikan pertanyaan di body notifikasi. */
const QUESTION_SNIPPET_LENGTH = 80;

function snippet(question: string): string {
  const trimmed = question.trim().replace(/\s+/g, ' ');
  const clipped = trimmed.length > QUESTION_SNIPPET_LENGTH ? `${trimmed.slice(0, QUESTION_SNIPPET_LENGTH - 1)}…` : trimmed;
  // Konten buatan user: di-escape supaya notifikasi tidak bisa dipakai menyuntik markup.
  return escapeHtml(clipped);
}

/**
 * Section 4 — pengingat pertanyaan profil yang belum dijawab setelah 48 jam.
 *
 * Jaminan "sekali kirim" ditegakkan di DATABASE, bukan di Redis: job mengklaim
 * baris lewat `updateMany({ where: { id, reminderSentAt: null } })` sehingga dua
 * instance yang berjalan bersamaan hanya punya satu pemenang. Redis tetap
 * dipakai untuk lock cron (pola service scheduler lain) dan jitter anti
 * thundering-herd.
 *
 * Hanya pertanyaan yang belum dijawab, tidak disembunyikan, dan milik penerima
 * yang masih aktif/tidak banned/belum terhapus yang dikabari — akun yang sudah
 * tidak bisa masuk tidak perlu diingatkan.
 */
@Injectable()
export class QuestionReminderService {
  private readonly logger = new Logger(QuestionReminderService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private notificationQueue: NotificationQueueService,
  ) {}

  @Cron('25 * * * *', { name: JOB_NAME, timeZone: 'Asia/Jakarta' })
  async sendUnansweredQuestionReminders(): Promise<void> {
    await cronJitter(15_000);
    if (!(await ensureRedisAvailable(this.redis, JOB_NAME))) return;

    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(LOCK_KEY, lockToken, LOCK_TTL_SECONDS);
    if (!acquired) return;

    try {
      const cutoff = new Date(Date.now() - UNANSWERED_REMINDER_HOURS * 60 * 60 * 1000);
      const pending = await this.prisma.profileQuestion.findMany({
        where: {
          answeredAt: null,
          isHidden: false,
          reminderSentAt: null,
          createdAt: { lte: cutoff },
          receiver: { isActive: true, isBanned: false, deletedAt: null },
        },
        // Tertua dulu: pertanyaan yang paling lama menunggu diingatkan lebih awal.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: BATCH_SIZE,
        select: {
          id: true,
          question: true,
          upvoteCount: true,
          receiverId: true,
          receiver: { select: { username: true, fullName: true } },
        },
      });

      let sent = 0;
      for (const item of pending) {
        const claimed = await this.prisma.profileQuestion.updateMany({
          where: { id: item.id, reminderSentAt: null },
          data: { reminderSentAt: new Date() },
        });
        // Kalah balapan dengan instance lain -> lewati, jangan kirim dua kali.
        if (claimed.count === 0) continue;

        try {
          const upvoteNote = item.upvoteCount > 0 ? ` (${item.upvoteCount} orang menunggu jawaban)` : '';
          await this.notificationQueue.enqueue({
            userId: item.receiverId,
            type: NotificationType.QUESTION_UNANSWERED_REMINDER,
            title: 'Pertanyaan belum dijawab',
            body: `"${snippet(item.question)}" sudah menunggu lebih dari ${UNANSWERED_REMINDER_HOURS} jam${upvoteNote}. Balas sekarang dari profil kamu.`,
            actionUrl: `/questions/${encodeURIComponent(item.id)}`,
            pushData: { questionId: item.id, reason: 'UNANSWERED_48H' },
          });
          sent += 1;
        } catch (error) {
          // Enqueue gagal: lepaskan klaim supaya dicoba lagi pada tick berikutnya,
          // lebih baik pengingat terlambat daripada hilang sama sekali.
          await this.prisma.profileQuestion
            .updateMany({ where: { id: item.id }, data: { reminderSentAt: null } })
            .catch((rollbackError: unknown) =>
              this.logger.warn(
                `Reminder claim rollback failed for question ${item.id}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
              ),
            );
          this.logger.error(
            `Failed to enqueue unanswered-question reminder for ${item.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (sent > 0) {
        this.logger.log(`Sent ${sent} unanswered-question reminder(s) out of ${pending.length} candidate(s)`);
      }
    } catch (error) {
      this.logger.error('QuestionReminderService FAILED', error);
    } finally {
      await this.redis
        .releaseLock(LOCK_KEY, lockToken)
        .catch((err: unknown) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}
