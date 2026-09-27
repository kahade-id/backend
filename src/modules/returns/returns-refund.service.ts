/**
 * GAP-D retur — persetujuan & eksekusi refund (G210, G211).
 *
 * KEUANGAN — baca dahulu:
 * - G210: approval MENCATAT nominal (ReturnRefundApproval + idempotency key)
 *   dan TIDAK memanggil provider apa pun.
 * - G211: eksekusi memakai SATU jalur ledger internal existing: debit
 *   availableBalance dompet seller → kredit availableBalance dompet buyer,
 *   baris wallet_transaction bertipe ORDER_REFUND, dengan row-lock
 *   (`SELECT ... FOR UPDATE`) + guard versi — pola yang sama dengan refund
 *   pasca-completion di disputes/mutual-resolution.service.ts.
 *   Jalur provider Midtrans (order-qris-payment.service) SENGAJA tidak dipakai:
 *   wrapper existing hanya full-amount, sedangkan retur butuh parsial, dan
 *   pasca-COMPLETED liabilitas ada pada dompet seller (refund via provider
 *   membayar dari kas platform tanpa clawback → saldo tidak konsisten).
 * - Idempotensi: klaim atomik PENDING/FAILED → EXECUTING via updateMany;
 *   panggil 2x konkuren → tepat 1 eksekusi, pemanggil kedua menerima hasil
 *   yang sudah ada / konflik yang jelas.
 */
import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import * as ErrorCodes from '../../common/constants/error-codes';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { generateWalletTxId } from '../../common/utils/id-generator.util';
import { getReturnsDb } from './returns.db';
import type {
  RefundApprovalStatus,
  ReturnActorType,
  ReturnRefundApprovalRow,
  ReturnRequestRow,
} from './returns.types';

export const RETURN_REFUND_INSUFFICIENT_FUNDS = 'RETURN_REFUND_INSUFFICIENT_SELLER_FUNDS';
export const RETURN_REFUND_ALREADY_FINAL = 'RETURN_REFUND_ALREADY_FINAL';

export interface CreateRefundApprovalInput {
  returnRequest: ReturnRequestRow;
  amountSen: bigint;
  approvedBy: string;
  approvedByRole: ReturnActorType;
  maxRefundSen: bigint | null;
}

export interface ExecuteRefundInput {
  sellerWalletId: string;
  buyerWalletId: string;
  orderDbId: string;
  returnPublicId: string;
  amountSen: bigint;
}

@Injectable()
export class ReturnsRefundService {
  private readonly logger = new Logger(ReturnsRefundService.name);

  constructor(
    private prisma: PrismaService,
    private serial: WalletTxSerialService,
  ) {}

  /**
   * G210 — catat persetujuan nominal. Idempoten via idempotencyKey unik:
   * approval kedua untuk return yang sama mengembalikan record existing
   * (bukan duplikat). TIDAK memanggil provider.
   */
  async createApproval(input: CreateRefundApprovalInput): Promise<ReturnRefundApprovalRow> {
    const { returnRequest, amountSen, approvedBy, approvedByRole, maxRefundSen } = input;
    if (amountSen <= BigInt(0)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Nominal refund harus lebih dari nol.',
      });
    }
    if (maxRefundSen !== null && amountSen > maxRefundSen) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Nominal refund melebihi pagu kebijakan retur.',
      });
    }
    const db = getReturnsDb(this.prisma);
    const idempotencyKey = `RTN-APPR-${returnRequest.returnId}`;
    const existing = await db.returnRefundApproval.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;
    try {
      return await db.returnRefundApproval.create({
        data: {
          returnRequestId: returnRequest.id,
          idempotencyKey,
          amount: amountSen,
          status: 'PENDING' as RefundApprovalStatus,
          approvedBy,
          approvedByRole,
          approvedAt: new Date(),
        },
      });
    } catch (err) {
      // Race: dua penyetuju konkuren — unique constraint menang, kembalikan existing.
      const raced = await db.returnRefundApproval.findUnique({ where: { idempotencyKey } });
      if (raced) return raced;
      throw err;
    }
  }

  /**
   * Klaim eksekusi secara atomik. Mengembalikan true bila klaim berhasil
   * (pemanggil ini yang mengeksekusi), false bila sudah di-claim/final oleh
   * proses lain — pemanggil kedua TIDAK mengeksekusi ulang.
   */
  async claimExecution(approvalId: string): Promise<boolean> {
    const db = getReturnsDb(this.prisma);
    const claimed = await db.returnRefundApproval.updateMany({
      where: { id: approvalId, status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'EXECUTING' as RefundApprovalStatus },
    });
    return claimed.count === 1;
  }

  async markExecuted(approvalId: string, walletTxIds: string[]): Promise<void> {
    const db = getReturnsDb(this.prisma);
    await db.returnRefundApproval.update({
      where: { id: approvalId },
      data: { status: 'EXECUTED' as RefundApprovalStatus, executedAt: new Date(), walletTxIds, failureReason: null },
    });
  }

  async markFailed(approvalId: string, reason: string): Promise<void> {
    const db = getReturnsDb(this.prisma);
    await db.returnRefundApproval.update({
      where: { id: approvalId },
      data: { status: 'FAILED' as RefundApprovalStatus, failureReason: reason },
    });
  }

  async getApproval(returnRequestDbId: string): Promise<ReturnRefundApprovalRow | null> {
    return getReturnsDb(this.prisma).returnRefundApproval.findUnique({
      where: { returnRequestId: returnRequestDbId },
    });
  }

  /**
   * G211 — SATU jalur eksekusi refund: ledger internal seller → buyer.
   * Mengembalikan txId kedua sisi untuk disimpan di approval (audit G220).
   * Melempar bila saldo seller tidak cukup — approval ditandai FAILED dan
   * masuk antrean admin (bukan di-silent).
   */
  async executeLedgerRefund(input: ExecuteRefundInput): Promise<string[]> {
    const { sellerWalletId, buyerWalletId, orderDbId, returnPublicId, amountSen } = input;
    const serial = await this.serial.getNextForPrefix('return_refund');
    const sellerTxId = generateWalletTxId(serial);
    const buyerTxId = generateWalletTxId(serial + 1);

    await this.prisma.$transaction(async (tx) => {
      // Kunci kedua dompet dengan urutan deterministik (hindari deadlock),
      // pola sama seperti mutual-resolution post-completion.
      const [firstId, secondId] = [sellerWalletId, buyerWalletId].sort();
      await tx.$queryRaw`SELECT id FROM wallets WHERE id IN (${firstId}, ${secondId}) ORDER BY id FOR UPDATE`;

      const sellerWallet = await tx.wallet.findUnique({ where: { id: sellerWalletId } });
      if (!sellerWallet) {
        throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Dompet penjual tidak ditemukan.' });
      }
      if (sellerWallet.isLocked) {
        throw new ConflictException({ code: 'WALLET_LOCKED', message: 'Dompet penjual terkunci.' });
      }
      const buyerWallet = await tx.wallet.findUnique({ where: { id: buyerWalletId } });
      if (!buyerWallet) {
        throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Dompet pembeli tidak ditemukan.' });
      }
      if (buyerWallet.isLocked) {
        throw new ConflictException({ code: 'WALLET_LOCKED', message: 'Dompet pembeli terkunci.' });
      }

      const debit = await tx.wallet.updateMany({
        where: { id: sellerWalletId, version: sellerWallet.version, availableBalance: { gte: amountSen } },
        data: {
          availableBalance: { decrement: amountSen },
          totalBalance: { decrement: amountSen },
          version: { increment: 1 },
        },
      });
      if (debit.count === 0) {
        const fresh = await tx.wallet.findUnique({ where: { id: sellerWalletId }, select: { availableBalance: true } });
        if (fresh && fresh.availableBalance < amountSen) {
          throw new BadRequestException({
            code: RETURN_REFUND_INSUFFICIENT_FUNDS,
            message: 'Saldo penjual tidak mencukupi untuk refund. Kasus diteruskan ke tim support.',
          });
        }
        throw new ConflictException({
          code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
          message: 'Konflik konkurensi saat refund retur, silakan coba lagi.',
        });
      }

      const credit = await tx.wallet.updateMany({
        where: { id: buyerWalletId, version: buyerWallet.version },
        data: {
          availableBalance: { increment: amountSen },
          totalBalance: { increment: amountSen },
          version: { increment: 1 },
        },
      });
      if (credit.count === 0) {
        throw new ConflictException({
          code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
          message: 'Konflik konkurensi saat refund retur, silakan coba lagi.',
        });
      }

      const description = `Refund retur ${returnPublicId} (seller → buyer)`;
      await tx.walletTransaction.create({
        data: {
          txId: sellerTxId,
          walletId: sellerWalletId,
          type: 'ORDER_REFUND',
          status: 'SUCCESS',
          amount: amountSen,
          balanceBefore: sellerWallet.availableBalance,
          balanceAfter: sellerWallet.availableBalance - amountSen,
          orderId: orderDbId,
          description: `${description} — debit penjual`,
        },
      });
      await tx.walletTransaction.create({
        data: {
          txId: buyerTxId,
          walletId: buyerWalletId,
          type: 'ORDER_REFUND',
          status: 'SUCCESS',
          amount: amountSen,
          balanceBefore: buyerWallet.availableBalance,
          balanceAfter: buyerWallet.availableBalance + amountSen,
          orderId: orderDbId,
          description: `${description} — kredit pembeli`,
        },
      });
    });

    this.logger.log(`Return refund ledger executed: ${returnPublicId} amount=${amountSen} txIds=${sellerTxId},${buyerTxId}`);
    return [sellerTxId, buyerTxId];
  }
}
