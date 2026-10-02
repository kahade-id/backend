import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { alertMoneyCronSkippedRedisDown, ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { toIdr } from '../../../common/utils/currency.util';
import { safeErrorMessage } from '../../../common/utils/background-reliability.util';
import { alertAdminsOnMoneyAnomaly } from '../common/money-alert.util';

/** EXECUTING lebih tua dari ini dianggap yatim (proses crash di tengah call DANA). */
const STALE_EXECUTING_MS = 30 * 60 * 1000;

/**
 * SYS-B-301 (audit sistemik ronde 3): pemulih untuk claim-state
 * `dana_refund_attempts.EXECUTING` yang macet permanen.
 *
 * Baris dibuat langsung berstatus EXECUTING; crash proses (OOM/SIGKILL/
 * restart) melewati blok catch → baris macet selamanya, dan retry dengan
 * idempotencyKey yang sama selalu melempar "sedang dieksekusi pihak lain"
 * → refund buyer terblokir permanen TANPA alert.
 *
 * Sweep ini (tiap 5 menit): EXECUTING dengan updatedAt basi (>30 mnt) →
 * kembalikan ke FAILED agar `retryFailedRefunds()` (cron dana-refund-retry)
 * menjemputnya. Aman karena:
 *  - Klaim ulang memakai `partnerRefundNo` deterministik yang SAMA
 *    (deriveDanaRefundNo) → DANA menduplikasi berdasarkan
 *    (merchantId, partnerRefundNo), bukan refund kedua.
 *  - Batas 30 menit jauh melampaui durasi wajar satu call refundOrder,
 *    sehingga kecil kemungkinan menabrak eksekutor yang masih hidup.
 *  - Reset via updateMany berpredikat status=EXECUTING (atomik).
 *
 * Mengapa tidak re-query status refund ke DANA dulu: wrapper
 * `DanaPaymentService` hanya mengekspos create/query(order)/refund/cancel —
 * TIDAK ada endpoint query status refund. Tanpa API itu, reset + retry
 * idempoten adalah pemulih yang benar.
 *
 * File `dana-direct-refund.service.ts` TIDAK diubah (milik alur klaim) —
 * sweep bekerja via Prisma langsung dari scheduler.
 */
@Injectable()
export class StaleRefundClaimSweepService {
  private readonly logger = new Logger(StaleRefundClaimSweepService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  // Tiap 5 menit — refund buyer yang macet harus pulih cepat.
  @Cron('*/5 * * * *', { name: 'stale-refund-claim-sweep', timeZone: 'Asia/Jakarta' })
  async sweepStaleExecutingRefunds(): Promise<void> {
    await cronJitter(10_000);
    if (!(await ensureRedisAvailable(this.redis, 'stale-refund-claim-sweep', {
        onRedisDown: () => alertMoneyCronSkippedRedisDown('stale-refund-claim-sweep'),
      }))) return;

    const lockKey = 'cron_lock:stale_refund_claim_sweep';
    const lockToken = randomUUID();
    if (!(await this.redis.setNx(lockKey, lockToken, 240))) return;

    try {
      const staleBefore = new Date(Date.now() - STALE_EXECUTING_MS);
      const stale = await this.prisma.danaRefundAttempt.findMany({
        where: { status: 'EXECUTING', updatedAt: { lt: staleBefore } },
        select: {
          id: true,
          idempotencyKey: true,
          paymentTransactionId: true,
          amountSen: true,
          partnerRefundNo: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
        take: 100,
      });

      let recovered = 0;
      for (const row of stale) {
        // Klaim atomik: hanya reset bila masih EXECUTING (race dengan
        // eksekutor yang baru menyelesaikan diabaikan secara aman).
        const reset = await this.prisma.danaRefundAttempt.updateMany({
          where: { id: row.id, status: 'EXECUTING' },
          data: { status: 'FAILED', reason: 'SYS-B-301: EXECUTING basi >30 mnt — di-reset agar retryFailedRefunds menjemput' },
        });
        if (reset.count === 0) continue;
        recovered++;

        this.logger.error(
          `STALE_REFUND_CLAIM dipulihkan: attempt=${row.id} key=${row.idempotencyKey} ` +
            `payment=${row.paymentTransactionId} amount=${toIdr(row.amountSen)} ` +
            `stuck sejak ${row.updatedAt.toISOString()} → FAILED (retry via partnerRefundNo ${row.partnerRefundNo})`,
        );
        await alertAdminsOnMoneyAnomaly({
          prisma: this.prisma,
          redis: this.redis,
          logger: this.logger,
          title: `Stale refund claim dipulihkan: ${row.idempotencyKey}`,
          body:
            `danaRefundAttempt ${row.id} (payment=${row.paymentTransactionId}, ` +
            `${toIdr(row.amountSen)}) macet di EXECUTING sejak ${row.updatedAt.toISOString()} ` +
            `(kemungkinan crash proses di tengah call DANA) → di-reset ke FAILED. ` +
            `Cron retryFailedRefunds akan mengeksekusi ulang dengan partnerRefundNo ` +
            `${row.partnerRefundNo} yang sama (idempoten di sisi DANA — bukan refund ganda). ` +
            `Pantau hingga SUCCESS.`,
          targetType: 'DanaRefundAttempt',
          targetId: row.id,
          redisAlertKey: 'stale_refund_claim',
          dedupKey: `stale_refund_claim_alerted:${row.id}`,
          dedupTtlSeconds: 86400,
        });
      }

      if (stale.length > 0 || recovered > 0) {
        this.logger.log(`stale-refund-claim-sweep: stale=${stale.length} recovered=${recovered}`);
      }
      await this.redis
        .setex(
          'cron_heartbeat:stale_refund_claim_sweep',
          86400,
          JSON.stringify({ ranAt: new Date().toISOString(), stale: stale.length, recovered }),
        )
        .catch((err: unknown) => this.logger.warn(`silent-catch: ${safeErrorMessage(err)}`));
    } catch (error) {
      this.logger.error(`stale-refund-claim-sweep gagal: ${safeErrorMessage(error)}`);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch(() => undefined);
    }
  }
}
