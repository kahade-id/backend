import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EscrowDisbursementScope, PaymentProvider, PaymentPurpose, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { sanitizeProviderError } from '../../common/utils/sanitize-provider-error';
import { DanaDirectRefundService } from './dana-direct-refund.service';
import { EscrowDisbursementService, ReleaseResult } from './escrow-disbursement.service';

export interface DisputeNoWalletSettlementInput {
  /** DB id order. */
  orderDbId: string;
  /** DB id dispute (untuk idempotency key). */
  disputeDbId: string;
  decision: 'FULL_BUYER' | 'FULL_SELLER' | 'SPLIT';
  buyerAmountSen: bigint;
  sellerAmountSen: bigint;
  reason: string;
}

export interface DisputeNoWalletSettlementResult {
  buyerRefunded: boolean;
  buyerRefundAlready: boolean;
  /** null bila porsi seller = 0 (tidak ada disbursement). */
  sellerDisbursement: ReleaseResult | null;
}

export interface ClaimAndSettleIntentInput {
  /** DB id dispute (unik di dispute_settlement_intents). */
  disputeId: string;
  /** DB id order. */
  orderDbId: string;
  decision: 'FULL_BUYER' | 'FULL_SELLER' | 'SPLIT';
  buyerAmountSen: bigint;
  sellerAmountSen: bigint;
  reason: string;
}

/**
 * Eksekusi finansial putusan sengketa TANPA menyentuh wallet internal
 * (mode BI-safe, misi tanpa-wallet).
 *
 * - Porsi buyer  → DANA Refund API ke metode bayar asal (idempoten per
 *   `DISPUTE:<disputeDbId>:BUYER`).
 * - Porsi seller → DANA Disbursement ke rekening bank seller terverifikasi
 *   (idempoten per `DISPUTE:<disputeDbId>:SELLER`, scope DISPUTE_RELEASE;
 *   HELD_NO_BANK bila seller belum punya rekening — dana tidak hangus).
 * - Platform fee tertahan di akun merchant DANA (tidak digerakkan).
 * - Sengketa PASCA-COMPLETION → fail-closed: dana sudah dicairkan ke seller,
 *   refund provider akan membayar dari kas platform tanpa clawback.
 *   Butuh penanganan manual/keputusan operasional — JANGAN ditebak.
 */
@Injectable()
export class DisputeDanaSettlementService {
  private readonly logger = new Logger(DisputeDanaSettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly danaDirectRefundService: DanaDirectRefundService,
    private readonly escrowDisbursementService: EscrowDisbursementService,
  ) {}

  async settleDisputeNoWallet(
    input: DisputeNoWalletSettlementInput,
  ): Promise<DisputeNoWalletSettlementResult> {
    const order = await this.prisma.order.findUnique({
      where: { id: input.orderDbId },
      select: { id: true, sellerId: true, completedAt: true },
    });
    if (!order) {
      throw new BadRequestException({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    }
    if (order.completedAt !== null) {
      // Fail-closed: dana sudah cair ke seller. Keputusan operasional/finance
      // diperlukan sebelum platform menalangi dari kas sendiri.
      throw new BadRequestException({
        code: 'DISPUTE_POST_COMPLETION_MANUAL_REVIEW',
        message:
          'Post-completion dispute in no-wallet mode requires manual review — funds already disbursed to seller',
      });
    }

    const payment = await this.prisma.paymentTransaction.findFirst({
      where: {
        orderId: input.orderDbId,
        purpose: PaymentPurpose.ORDER_ESCROW,
        provider: PaymentProvider.DANA,
        status: PaymentStatus.SUCCESS,
        danaPayKind: { not: null },
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) {
      throw new BadRequestException({
        code: 'DISPUTE_NO_DANA_PAYMENT',
        message: 'No DANA-direct escrow payment found for this order — cannot settle without wallet',
      });
    }

    let buyerRefunded = false;
    let buyerRefundAlready = false;
    if (input.buyerAmountSen > BigInt(0)) {
      const res = await this.danaDirectRefundService.refundAmount({
        paymentDbId: payment.id,
        amountSen: input.buyerAmountSen,
        reason: input.reason,
        idempotencyKey: `DISPUTE:${input.disputeDbId}:BUYER`,
      });
      // SEC-104(a): porsi buyer GAGAL (mis. NOT_ELIGIBLE) → THROW, jangan
      // lanjut diam-diam ke porsi seller — porsi buyer akan hilang tanpa jejak.
      if (!res.refunded) {
        throw new BadRequestException({
          code: 'DISPUTE_BUYER_REFUND_FAILED',
          message: `Refund porsi buyer gagal (${res.reason}) — settlement dibatalkan (fail-closed), porsi seller TIDAK dicairkan`,
        });
      }
      buyerRefunded = res.refunded;
      buyerRefundAlready = 'already' in res ? (res.already ?? false) : false;
      this.logger.log(
        `Dispute ${input.disputeDbId}: buyer refund ${input.buyerAmountSen} sen → ` +
          `refunded=${buyerRefunded} already=${buyerRefundAlready}`,
      );
    }

    let sellerDisbursement: ReleaseResult | null = null;
    if (input.sellerAmountSen > BigInt(0)) {
      sellerDisbursement = await this.escrowDisbursementService.releaseFunds({
        idempotencyKey: `DISPUTE:${input.disputeDbId}:SELLER`,
        scope: EscrowDisbursementScope.DISPUTE_RELEASE,
        scopeRefId: input.disputeDbId,
        orderId: input.orderDbId,
        sellerId: order.sellerId,
        amountSen: input.sellerAmountSen,
        reason: `Dispute ${input.decision}: porsi seller`,
      });
      this.logger.log(
        `Dispute ${input.disputeDbId}: seller disbursement ${input.sellerAmountSen} sen → ${sellerDisbursement.outcome}`,
      );
    }

    return { buyerRefunded, buyerRefundAlready, sellerDisbursement };
  }

  /**
   * SEC-104: eksekusi settlement dari baris intent yang durable
   * (`dispute_settlement_intents`, dibuat DI DALAM tx putusan).
   *
   * - Klaim atomik PENDING/FAILED → CLAIMED: hanya SATU eksekutor yang menang
   *   (post-commit accept + cron sweep boleh berlomba; yang kalah skip).
   * - Sukses → intent DONE. Gagal → intent FAILED + lastError, lalu RETHROW
   *   (fail-closed; cron `dispute-settlement-sweep` retry sampai batas attempt).
   * - Kalah klaim → return null (bukan error).
   */
  async claimAndSettleIntent(
    input: ClaimAndSettleIntentInput,
  ): Promise<DisputeNoWalletSettlementResult | null> {
    const claimed = await this.prisma.disputeSettlementIntent.updateMany({
      where: { disputeId: input.disputeId, status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'CLAIMED', claimedAt: new Date(), attemptCount: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      this.logger.warn(
        `Dispute settlement intent ${input.disputeId} sudah diklaim/done pihak lain — skip`,
      );
      return null;
    }
    try {
      const result = await this.settleDisputeNoWallet({
        orderDbId: input.orderDbId,
        disputeDbId: input.disputeId,
        decision: input.decision,
        buyerAmountSen: input.buyerAmountSen,
        sellerAmountSen: input.sellerAmountSen,
        reason: input.reason,
      });
      await this.prisma.disputeSettlementIntent.update({
        where: { disputeId: input.disputeId },
        data: { status: 'DONE', doneAt: new Date(), lastError: null },
      });
      return result;
    } catch (err) {
      // SYS-B-503: lastError hanya kode generik (pola SEC-204); pesan mentah
      // (bisa mengandung PII provider) hanya ke log internal teredaksi.
      const sanitized = sanitizeProviderError(err);
      this.logger.error(
        `Dispute settlement intent ${input.disputeId} FAILED [${sanitized.code}]: ${sanitized.detailForLog}`,
      );
      await this.prisma.disputeSettlementIntent
        .update({
          where: { disputeId: input.disputeId },
          data: { status: 'FAILED', lastError: sanitized.code },
        })
        .catch((markError: unknown) =>
          this.logger.error(
            `Gagal menandai settlement intent FAILED ${input.disputeId}: ${
              markError instanceof Error ? markError.message : String(markError)
            }`,
          ),
        );
      throw err;
    }
  }
}
