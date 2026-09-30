import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { alertMoneyCronSkippedRedisDown, ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { DanaDirectRefundService } from '../../no-wallet/dana-direct-refund.service';
import { EscrowDisbursementService } from '../../no-wallet/escrow-disbursement.service';
import { ReferralService } from '../../referral/referral.service';
import { WalletModeService } from '../../wallet-mode/wallet-mode.service';

/**
 * M3: sweep rekonsiliasi finansial mode tanpa-wallet.
 *
 * - Refund DANA yang FAILED (attempt durable `dana_refund_attempts`) dicoba
 *   ulang — klaim atomik di DanaDirectRefundService menjamin tepat satu
 *   eksekutor per idempotency key.
 * - Disbursement PENDING/FAILED dicoba ulang via EscrowDisbursementService.retryDue().
 * - Disbursement PROCESSING yang macet (notify webhook tidak tiba) direkonsiliasi
 *   via EscrowDisbursementService.reconcileProcessing() — query status ke DANA.
 * - M4: referralReward yang diklaim tapi belum cair (isCredited=false) dibayar
 *   via disbursement scope REFERRAL — hanya bila wallet mati.
 *
 * Tanpa sweep ini, kegagalan post-commit (mis. putusan sengketa) akan
 * menggantung selamanya. Money-safe: tidak pernah mengarang status —
 * hanya memanggil ulang jalur idempoten yang sama.
 */
@Injectable()
export class DanaRefundRetryService {
  private readonly logger = new Logger(DanaRefundRetryService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private danaDirectRefundService: DanaDirectRefundService,
    private escrowDisbursementService: EscrowDisbursementService,
    private referralService: ReferralService,
    private walletMode: WalletModeService,
  ) {}

  // Jalan tiap jam di menit ke-50 (hindari tabrakan dengan refund-reconciliation :35).
  @Cron('50 * * * *', { name: 'dana-refund-retry' })
  async retryStaleNoWalletMoney(): Promise<void> {
    await cronJitter(20_000);
    if (!(await ensureRedisAvailable(this.redis, 'dana-refund-retry', {
        // Job kritis-uang — skip karena Redis down harus termonitor, bukan senyap.
        onRedisDown: () => alertMoneyCronSkippedRedisDown('dana-refund-retry'),
      }))) return;

    const lockKey = 'cron_lock:dana_refund_retry';
    const lockTtl = 600;
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, lockTtl);
    if (!acquired) return;

    try {
      const refundResult = await this.danaDirectRefundService.retryFailedRefunds(50);
      if (refundResult.retried > 0) {
        this.logger.log(
          `dana-refund-retry: retried=${refundResult.retried} succeeded=${refundResult.succeeded}`,
        );
      }
      const disbursed = await this.escrowDisbursementService.retryDue(50);
      if (disbursed > 0) {
        this.logger.log(`dana-refund-retry: disbursement retry settled=${disbursed}`);
      }
      const reconciled = await this.escrowDisbursementService.reconcileProcessing(50);
      if (reconciled.checked > 0) {
        this.logger.log(
          `dana-refund-retry: disbursement reconcile checked=${reconciled.checked} settled=${reconciled.settled}`,
        );
      }
      // M4: payout referral pending — hanya relevan bila wallet mati.
      if (!this.walletMode.isWalletEnabled()) {
        const referral = await this.referralService.payoutPendingReferralRewards(50);
        if (referral.attempted > 0) {
          this.logger.log(
            `dana-refund-retry: referral payout attempted=${referral.attempted} released=${referral.released}`,
          );
        }
      }
    } finally {
      await this.redis.del(lockKey).catch(() => undefined);
    }
  }
}
