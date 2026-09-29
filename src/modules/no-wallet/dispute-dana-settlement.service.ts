import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EscrowDisbursementScope, PaymentProvider, PaymentPurpose, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
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
}
