import { Logger } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { safeErrorMessage } from '../../../common/utils/background-reliability.util';

export interface MoneyAlertInput {
  prisma: PrismaService;
  redis: RedisService;
  logger: Logger;
  title: string;
  body: string;
  /** mis. 'Reconciliation', 'EscrowDisbursement', 'DanaRefundAttempt'. */
  targetType: string;
  targetId: string;
  /** Suffix kunci Redis → `cron_alert:<suffix>` (TTL 24 jam). */
  redisAlertKey: string;
  /**
   * Bila diisi: alert hanya dikirim sekali per TTL via setNx (anti-spam
   * untuk sweep yang berjalan tiap beberapa menit). Kembalikan `false`
   * bila alert di-dedup (tidak dikirim ulang).
   */
  dedupKey?: string;
  dedupTtlSeconds?: number;
}

/**
 * SYS-B-101/301/302/303/304/306 (audit sistemik ronde 3): pola alert tunggal
 * untuk anomali uang dari scheduler.
 *
 * Mengikuti pola `alertAdminsOnMismatch` yang sudah ada di
 * daily-reconciliation.service.ts (adminAuditLog ke SUPER_ADMIN + logger),
 * ditambah Redis alert key (`cron_alert:*`) mengikuti pola dlq-monitor /
 * webhook-retry agar monitor eksternal bisa mem-poll, plus dedup opsional
 * via setNx agar sweep berfrekuensi tinggi tidak membanjiri audit log.
 *
 * Fail-closed: kegagalan tulis alert tidak pernah menggagalkan sweep —
 * selalu best-effort dengan log.
 */
export async function alertAdminsOnMoneyAnomaly(input: MoneyAlertInput): Promise<boolean> {
  const { prisma, redis, logger, title, body, targetType, targetId, redisAlertKey } = input;

  if (input.dedupKey) {
    const first = await redis
      .setNx(input.dedupKey, new Date().toISOString(), input.dedupTtlSeconds ?? 86400)
      .catch((err: unknown) => {
        logger.warn(`silent-catch: dedup alert gagal: ${safeErrorMessage(err)}`);
        return true as boolean;
      });
    if (!first) return false;
  }

  try {
    const admins = await prisma.adminUser.findMany({
      where: { isActive: true, deletedAt: null, role: 'SUPER_ADMIN' },
      select: { id: true },
      take: 5,
    });
    if (admins.length === 0) {
      const fallback = await prisma.adminUser.findFirst({
        where: { isActive: true, deletedAt: null },
        select: { id: true },
      });
      if (fallback) admins.push(fallback);
    }
    for (const admin of admins) {
      await prisma.adminAuditLog
        .create({
          data: {
            adminId: admin.id,
            // AuditAction enum tidak punya bucket SYSTEM_*; ADMIN_ACTION
            // adalah bucket generik terdekat (pola daily-reconciliation).
            // Semantik dipertahankan di prefix deskripsi `[SYSTEM ALERT]`.
            action: AuditAction.ADMIN_ACTION,
            targetType,
            targetId,
            description: `[SYSTEM ALERT] ${title}: ${body}`.slice(0, 2000),
            ipAddress: 'system',
          },
        })
        .catch((err: unknown) =>
          logger.warn(`silent-catch: tulis adminAuditLog gagal: ${safeErrorMessage(err)}`),
        );
    }
  } catch (err: unknown) {
    logger.error(`Gagal menyiapkan admin alert "${title}": ${safeErrorMessage(err)}`);
  }

  await redis
    .setex(
      `cron_alert:${redisAlertKey}`,
      86400,
      JSON.stringify({ alertAt: new Date().toISOString(), title, body: body.slice(0, 500), targetType, targetId }),
    )
    .catch((err: unknown) =>
      logger.warn(`silent-catch: tulis redis alert key gagal: ${safeErrorMessage(err)}`),
    );

  logger.error(`[ADMIN ALERT] ${title}: ${body}`);
  return true;
}

export interface DisbursementAttentionInput {
  prisma: PrismaService;
  redis: RedisService;
  logger: Logger;
  disbursementId: string;
  idempotencyKey?: string | null;
  status: 'HELD_NO_BANK' | 'NEEDS_REVIEW';
  reason: string;
}

/**
 * SYS-B-306: helper alert untuk setiap baris EscrowDisbursement yang masuk
 * status HELD_NO_BANK / NEEDS_REVIEW.
 *
 * Dibuat di modul scheduler agar bisa dipanggil dari DUA tempat:
 *  1. (Direkomendasikan, oleh W1) langsung dari
 *     `dana-webhook-disbursement.service.ts` `applyStatus()` tepat setelah
 *     transisi ke NEEDS_REVIEW — alert seketika, tanpa menunggu sweep.
 *  2. Safety net: `disbursement-attention-sweep` (cron tiap 10 menit)
 *     memindai baris HELD_NO_BANK/NEEDS_REVIEW dan memanggil helper ini —
 *     menjamin alert walau transisi terjadi dari jalur lain (mis. settle()
 *     HELD_NO_BANK di escrow-disbursement.service.ts).
 *
 * Dedup via Redis (`disbursement_alerted:<id>`, TTL 7 hari) sehingga
 * pemanggilan dari kedua jalur tidak menggandakan alert.
 */
export async function alertDisbursementNeedsAttention(
  input: DisbursementAttentionInput,
): Promise<boolean> {
  const { status, disbursementId, idempotencyKey, reason } = input;
  const title =
    status === 'HELD_NO_BANK'
      ? `Disbursement HELD_NO_BANK: ${disbursementId}`
      : `Disbursement NEEDS_REVIEW: ${disbursementId}`;
  const body =
    `EscrowDisbursement ${disbursementId}` +
    (idempotencyKey ? ` (key=${idempotencyKey})` : '') +
    ` masuk status ${status} — ${reason}. ` +
    `Dana fail-closed (tidak hilang) tetapi tertahan; butuh tindakan admin.`;
  return alertAdminsOnMoneyAnomaly({
    prisma: input.prisma,
    redis: input.redis,
    logger: input.logger,
    title,
    body,
    targetType: 'EscrowDisbursement',
    targetId: disbursementId,
    redisAlertKey: 'disbursement_needs_attention',
    dedupKey: `disbursement_alerted:${disbursementId}`,
    dedupTtlSeconds: 7 * 86400,
  });
}
