import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

export const REFERRAL_BURST_THRESHOLD = 5;
export const REFERRAL_BURST_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Audit referral 2026-10-10 (B18): deteksi lonjakan relasi referral (≥5 relasi
 * baru per referrer dalam 24 jam → `flaggedForReview`) dulu hanya hidup di
 * `ReferralService.applyCode`, sedangkan jalur UTAMA (kode referral saat
 * registrasi di AuthService) tidak pernah diperiksa. Dipusatkan di sini agar
 * kedua jalur memakai aturan yang sama. Best-effort: Redis boleh null/gagal —
 * hitungan DB tetap menjadi sumber kebenaran.
 */
export async function flagReferralBurstIfNeeded(
  deps: { prisma: PrismaService | Prisma.TransactionClient; redis: RedisService | null; logger: Logger },
  referrerId: string,
  relationId?: string,
): Promise<void> {
  const { prisma, redis, logger } = deps;
  const key = `referral:relations_24h:${referrerId}`;
  const redisCount = redis
    ? await redis.incrWithTtl(key, REFERRAL_BURST_WINDOW_SECONDS).catch((error: unknown) => {
        logger.warn(`Referral burst Redis counter failed for referrer=${referrerId}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      })
    : null;
  const cutoff = new Date(Date.now() - REFERRAL_BURST_WINDOW_SECONDS * 1000);
  const dbCount = await prisma.referralRelation.count({
    where: { referrerId, appliedAt: { gte: cutoff } },
  });
  if ((redisCount ?? 0) < REFERRAL_BURST_THRESHOLD && dbCount < REFERRAL_BURST_THRESHOLD) return;
  const reviewReason = `Referrer received at least ${REFERRAL_BURST_THRESHOLD} new relations in 24 hours`;
  await prisma.referralRelation.updateMany({
    where: { referrerId, appliedAt: { gte: cutoff }, flaggedForReview: false },
    data: { flaggedForReview: true, flaggedForReviewAt: new Date(), reviewReason },
  });
  if (relationId) {
    await prisma.referralRelation.updateMany({
      where: { id: relationId },
      data: { flaggedForReview: true, flaggedForReviewAt: new Date(), reviewReason },
    });
  }
}
