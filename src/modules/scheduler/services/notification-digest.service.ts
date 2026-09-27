import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { generateNotifId } from '../../../common/utils/id-generator.util';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { getMinutesInTimezone, isMinutesInRange } from '../../../common/utils/timezone.util';

/**
 * Item 8 (batch 2026-09-28) — Digest notifikasi.
 *
 * Cron per jam: untuk user dengan preferensi digestFrequency daily/weekly
 * yang sedang jatuh tempo, kirim SATU notifikasi ringkasan berisi:
 * follower baru, like etalase baru, dan update order sejak digest terakhir.
 *
 * Aturan:
 * - Hormati quiet hours: bila sekarang jam sunyi user, digest dilewati
 *   (tetap jatuh tempo — dicoba lagi di tick berikutnya).
 * - Hanya kirim bila ada konten. Bila tidak ada konten, lastDigestSentAt
 *   tetap dimajukan agar tidak memindai ulang tiap jam.
 * - daily: jatuh tempo sekali sehari, mulai 07:00 waktu lokal user.
 * - weekly: jatuh tempo tiap Senin, mulai 07:00 waktu lokal user.
 * - Digest pertama (lastDigestSentAt null): dikirim di tick berikutnya
 *   setelah user mengaktifkan (di luar jam sunyi).
 */
export type DigestDueState = 'due' | 'not-due' | 'quiet';

export interface DigestPrefs {
  userId: string;
  digestFrequency: string | null;
  lastDigestSentAt: Date | null;
  quietHoursEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursTimezone: string | null;
}

export interface DigestContent {
  newFollowers: number;
  followerNames: string[];
  newLikes: number;
  orderUpdates: number;
}

const DIGEST_SEND_AFTER_MINUTES = 7 * 60; // 07:00 waktu lokal user
const DIGEST_BATCH_SIZE = 500;

@Injectable()
export class NotificationDigestService {
  private readonly logger = new Logger(NotificationDigestService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  // ---------- helper zona waktu (pure, bisa di-unit-test) ----------

  /** Awal hari (00:00) dalam zona waktu user, sebagai Date UTC. */
  startOfDayInTimezone(now: Date, timeZone?: string | null): Date {
    const tz = timeZone || 'Asia/Jakarta';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '01';
    // "YYYY-MM-DD 00:00" sebagai UTC semu, lalu koreksi dengan offset zona
    // waktu pada tanggal tersebut (DST-safe untuk zona yang memilikinya).
    const ymd = `${get('year')}-${get('month')}-${get('day')}T00:00:00`;
    const localAsUtc = new Date(`${ymd}Z`);
    const offsetMs = this.tzOffsetMs(now, tz);
    return new Date(localAsUtc.getTime() - offsetMs);
  }

  /** Offset zona waktu (ms) pada tanggal tertentu: local - UTC. */
  private tzOffsetMs(date: Date, timeZone: string): number {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = dtf.formatToParts(date);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') === 24 ? 0 : get('hour'), get('minute'), get('second'));
    return asUtc - date.getTime();
  }

  /** Awal pekan (Senin 00:00) dalam zona waktu user, sebagai Date UTC. */
  startOfWeekInTimezone(now: Date, timeZone?: string | null): Date {
    const tz = timeZone || 'Asia/Jakarta';
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
    // en-US short: Sun, Mon, Tue, Wed, Thu, Fri, Sat
    const daysSinceMonday = ({ Sun: 6, Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5 } as Record<string, number>)[weekday] ?? 0;
    const startOfToday = this.startOfDayInTimezone(now, tz);
    return new Date(startOfToday.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
  }

  isMondayInTimezone(now: Date, timeZone?: string | null): boolean {
    const tz = timeZone || 'Asia/Jakarta';
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now) === 'Mon';
  }

  /** Tentukan status jatuh tempo digest untuk satu user. */
  isDigestDue(prefs: DigestPrefs, now: Date): DigestDueState {
    const freq = prefs.digestFrequency;
    if (freq !== 'daily' && freq !== 'weekly') return 'not-due';
    const tz = prefs.quietHoursTimezone || 'Asia/Jakarta';

    // Quiet hours: lewati pengiriman, tetap jatuh tempo untuk tick berikutnya.
    if (prefs.quietHoursEnabled) {
      const minutes = getMinutesInTimezone(now, tz);
      if (isMinutesInRange(minutes, prefs.quietHoursStart || '22:00', prefs.quietHoursEnd || '07:00')) {
        return 'quiet';
      }
    }

    const minutesNow = getMinutesInTimezone(now, tz);
    const last = prefs.lastDigestSentAt;
    if (freq === 'daily') {
      if (!last) return 'due';
      if (last < this.startOfDayInTimezone(now, tz) && minutesNow >= DIGEST_SEND_AFTER_MINUTES) return 'due';
      return 'not-due';
    }
    // weekly
    if (!last) return 'due';
    if (this.isMondayInTimezone(now, tz) && minutesNow >= DIGEST_SEND_AFTER_MINUTES && last < this.startOfWeekInTimezone(now, tz)) {
      return 'due';
    }
    return 'not-due';
  }

  // ---------- konten digest ----------

  async collectDigestContent(userId: string, since: Date): Promise<DigestContent> {
    const [follows, newLikes, orderUpdates] = await Promise.all([
      this.prisma.follow.findMany({
        where: { followingId: userId, createdAt: { gte: since } },
        select: { follower: { select: { username: true, fullName: true } } },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.prisma.showcaseLike.count({
        where: { showcase: { userId }, createdAt: { gte: since } },
      }),
      this.prisma.notification.count({
        where: {
          userId,
          category: 'TRANSAKSI',
          createdAt: { gte: since },
          type: { not: NotificationType.DIGEST_SUMMARY },
        },
      }),
    ]);
    const totalFollows = await this.prisma.follow.count({
      where: { followingId: userId, createdAt: { gte: since } },
    });
    return {
      newFollowers: totalFollows,
      followerNames: follows.map((f) => f.follower.fullName || f.follower.username || 'Pengguna'),
      newLikes,
      orderUpdates,
    };
  }

  buildDigestBody(frequency: 'daily' | 'weekly', content: DigestContent): { title: string; body: string } {
    const title = frequency === 'daily' ? 'Ringkasan Harian' : 'Ringkasan Mingguan';
    const lines: string[] = [];
    if (content.newFollowers > 0) {
      const names = content.followerNames.slice(0, 3).join(', ');
      const extra = content.newFollowers > 3 ? ` dan ${content.newFollowers - 3} lainnya` : '';
      lines.push(`• ${content.newFollowers} pengikut baru${names ? `: ${names}${extra}` : ''}`);
    }
    if (content.newLikes > 0) {
      lines.push(`• ${content.newLikes} suka baru di etalase Anda`);
    }
    if (content.orderUpdates > 0) {
      lines.push(`• ${content.orderUpdates} update order`);
    }
    return { title, body: lines.join('\n') };
  }

  private hasContent(content: DigestContent): boolean {
    return content.newFollowers > 0 || content.newLikes > 0 || content.orderUpdates > 0;
  }

  /** Proses satu user: kumpulkan konten, kirim bila ada, majukan lastDigestSentAt. */
  async processUserDigest(prefs: DigestPrefs, now: Date): Promise<'sent' | 'empty' | 'skipped'> {
    const due = this.isDigestDue(prefs, now);
    if (due !== 'due') return 'skipped';
    const frequency = prefs.digestFrequency as 'daily' | 'weekly';
    const since = prefs.lastDigestSentAt ?? new Date(now.getTime() - (frequency === 'daily' ? 24 : 7 * 24) * 60 * 60 * 1000);

    const content = await this.collectDigestContent(prefs.userId, since);
    // Majukan penanda selalu (kecuali quiet — sudah di-filter di isDigestDue)
    // agar tick berikutnya tidak memindai ulang rentang yang sama.
    await this.prisma.notificationPreference.update({
      where: { userId: prefs.userId },
      data: { lastDigestSentAt: now },
    });

    if (!this.hasContent(content)) return 'empty';

    const { title, body } = this.buildDigestBody(frequency, content);
    await this.prisma.notification.create({
      data: {
        notifId: generateNotifId(),
        userId: prefs.userId,
        type: NotificationType.DIGEST_SUMMARY,
        category: getCategoryForType(NotificationType.DIGEST_SUMMARY),
        title,
        body,
        isRead: false,
        metadata: {
          kind: 'digest',
          frequency,
          newFollowers: content.newFollowers,
          newLikes: content.newLikes,
          orderUpdates: content.orderUpdates,
        },
      },
    });
    try {
      this.prisma.emitNotificationCreated({
        userId: prefs.userId,
        title,
        body,
        data: { type: 'DIGEST_SUMMARY', frequency },
      });
    } catch (error: unknown) {
      this.logger.warn(`Digest realtime emit failed for ${prefs.userId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.logger.log(`Digest ${frequency} terkirim ke ${prefs.userId}`);
    return 'sent';
  }

  // ---------- cron ----------

  @Cron('0 * * * *', { name: 'notification-digest' })
  async sendDigests(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'notification-digest'))) return;

    const lockKey = 'cron_lock:notification_digest';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 900);
    if (!acquired) return;

    const now = new Date();
    let cursor: string | undefined;
    let sent = 0;
    let empty = 0;

    try {
      for (;;) {
        const batch = await this.prisma.notificationPreference.findMany({
          where: { digestFrequency: { in: ['daily', 'weekly'] } },
          select: {
            userId: true,
            digestFrequency: true,
            lastDigestSentAt: true,
            quietHoursEnabled: true,
            quietHoursStart: true,
            quietHoursEnd: true,
            quietHoursTimezone: true,
          },
          orderBy: { userId: 'asc' },
          ...(cursor ? { cursor: { userId: cursor }, skip: 1 } : {}),
          take: DIGEST_BATCH_SIZE,
        });
        if (batch.length === 0) break;
        for (const prefs of batch) {
          try {
            const result = await this.processUserDigest(prefs as DigestPrefs, now);
            if (result === 'sent') sent++;
            else if (result === 'empty') empty++;
          } catch (error: unknown) {
            this.logger.error(`Digest gagal untuk ${prefs.userId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (batch.length < DIGEST_BATCH_SIZE) break;
        cursor = batch[batch.length - 1].userId;
      }
      this.logger.log(`notification-digest selesai: ${sent} terkirim, ${empty} tanpa konten`);
    } finally {
      try {
        const current = await this.redis.get(lockKey);
        if (current === lockToken) await this.redis.del(lockKey);
      } catch {
        // best-effort release
      }
    }
  }
}
