import { ConflictException } from '@nestjs/common';
import {
  Prisma,
  VoucherType,
  WalletTransactionStatus,
  WalletTransactionType,
  EscrowDisbursementScope,
} from '@prisma/client';
import { generateWalletTxId } from './id-generator.util';
import * as ErrorCodes from '../constants/error-codes';

/**
 * Batch 1-money (EO-005 / V-003): SATU-SATUNYA tempat kredit cashback voucher.
 *
 * Sebelumnya logika ini inline di `OrderStateService.completeOrder`, sehingga tiga jalur
 * penyelesaian lain (cron auto-complete, admin force-complete, verdict dispute) tidak
 * mewarisinya dan cashback hangus diam-diam.
 *
 * Idempotensi berlapis:
 *  1. Guard ledger — lewati bila sudah ada baris CAMPAIGN_CASHBACK SUCCESS untuk order ini
 *     (menangkal retry cron / double-submit / post-completion dispute setelah complete).
 *  2. Guard OCC — `updateMany` wallet ber-guard `version`; konflik konkurensi melempar
 *     ConflictException agar pemanggil me-retry lewat wrapper-nya masing-masing.
 *
 * Helper me-re-fetch wallet penerima di dalam tx yang diberikan, sehingga pemanggil tidak
 * perlu mewariskan state version/balance (menghindari kerumitan version-chaining).
 * Uang dalam sen (BigInt). Kredit SELALU disertai baris ledger dalam tx yang sama.
 */
export interface CashbackCreditParams {
  /** Prisma internal order id (bukan orderId publik). */
  orderDbId: string;
  /** orderId publik — hanya untuk deskripsi ledger. */
  orderPublicId: string;
  /** Label sumber pemanggil, mis. 'completeOrder' | 'auto-complete' | 'force-complete' | 'dispute-verdict'. */
  source: string;
}

export interface CashbackCreditResult {
  credited: boolean;
  /** Jumlah sen yang dikredit (0 bila tidak dikredit). */
  amount: bigint;
  /** userId penerima cashback (pemilik voucherUsage). */
  userId: string | null;
  /** Kode voucher — untuk notifikasi pemanggil. */
  voucherCode: string | null;
}

const NO_CREDIT: CashbackCreditResult = {
  credited: false,
  amount: BigInt(0),
  userId: null,
  voucherCode: null,
};

export async function creditCashbackIfEligible(
  tx: Prisma.TransactionClient,
  getNextSerial: () => Promise<number>,
  params: CashbackCreditParams,
): Promise<CashbackCreditResult> {
  // Guard 1 — idempotensi ledger: cashback untuk order ini sudah pernah dikredit.
  const alreadyCredited = await tx.walletTransaction.findFirst({
    where: {
      orderId: params.orderDbId,
      type: WalletTransactionType.CAMPAIGN_CASHBACK,
      status: WalletTransactionStatus.SUCCESS,
    },
    select: { id: true },
  });
  if (alreadyCredited) return NO_CREDIT;

  // Guard 2 — harus ada voucherUsage cashback dengan nominal > 0.
  const usage = await tx.voucherUsage.findFirst({
    where: {
      orderId: params.orderDbId,
      voucher: { voucherType: VoucherType.WALLET_CASHBACK },
    },
    select: {
      id: true,
      userId: true,
      discountApplied: true,
      voucher: { select: { code: true } },
    },
  });
  const amount = usage?.discountApplied ?? BigInt(0);
  if (!usage || amount <= BigInt(0)) return NO_CREDIT;

  const wallet = await tx.wallet.findUnique({ where: { userId: usage.userId } });
  if (!wallet) return NO_CREDIT;
  if (wallet.isLocked) return NO_CREDIT;

  const balanceBefore = wallet.availableBalance;
  const updated = await tx.wallet.updateMany({
    where: { id: wallet.id, version: wallet.version },
    data: {
      availableBalance: { increment: amount },
      totalBalance: { increment: amount },
      version: { increment: 1 },
    },
  });
  if (updated.count === 0) {
    throw new ConflictException({
      code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
      message: `Concurrent wallet update during cashback credit (${params.source}), please retry`,
    });
  }

  const cashbackTxId = generateWalletTxId(await getNextSerial());
  await tx.walletTransaction.create({
    data: {
      txId: cashbackTxId,
      walletId: wallet.id,
      type: WalletTransactionType.CAMPAIGN_CASHBACK,
      status: WalletTransactionStatus.SUCCESS,
      amount,
      balanceBefore,
      balanceAfter: balanceBefore + amount,
      orderId: params.orderDbId,
      description: `Campaign cashback for order ${params.orderPublicId} using voucher ${usage.voucher.code} (${params.source})`,
    },
  });

  return { credited: true, amount, userId: usage.userId, voucherCode: usage.voucher.code };
}

/**
 * M4 no-wallet — payout cashback via disbursement DANA (bukan wallet).
 *
 * Pola dua fase agar money-safe:
 *  1. `planDanaCashback(tx, ...)` — read-only di dalam tx completion pemanggil:
 *     cek eligibilitas voucher + guard idempotensi (disbursement untuk order
 *     ini sudah ada → null). TIDAK menyentuh wallet sama sekali.
 *  2. `executeDanaCashback(...)` — dipanggil pemanggil POST-COMMIT: mengeksekusi
 *     via EscrowDisbursementService.releaseFunds (idempoten, durable).
 *
 * Kunci idempotensi stabil: `CASHBACK:<orderDbId>` — satu cashback per order.
 * Tanpa rekening bank terverifikasi → HELD_NO_BANK (fail-closed, tidak hangus;
 * dicoba lagi oleh scheduler via EscrowDisbursementService.retryDue()).
 */
export interface DanaCashbackIntent {
  userId: string;
  amountSen: bigint;
  voucherCode: string | null;
  usageId: string;
}

export const danaCashbackKey = (orderDbId: string): string => `CASHBACK:${orderDbId}`;

export async function planDanaCashback(
  tx: Prisma.TransactionClient,
  params: CashbackCreditParams,
): Promise<DanaCashbackIntent | null> {
  const existing = await tx.escrowDisbursement.findUnique({
    where: { idempotencyKey: danaCashbackKey(params.orderDbId) },
    select: { id: true },
  });
  if (existing) return null;

  const usage = await tx.voucherUsage.findFirst({
    where: {
      orderId: params.orderDbId,
      voucher: { voucherType: VoucherType.WALLET_CASHBACK },
    },
    select: {
      id: true,
      userId: true,
      discountApplied: true,
      voucher: { select: { code: true } },
    },
  });
  const amount = usage?.discountApplied ?? BigInt(0);
  if (!usage || amount <= BigInt(0)) return null;

  return {
    userId: usage.userId,
    amountSen: amount,
    voucherCode: usage.voucher.code,
    usageId: usage.id,
  };
}

export interface DanaCashbackExecutor {
  releaseFunds: (params: {
    idempotencyKey: string;
    scope: EscrowDisbursementScope;
    sellerId: string;
    amountSen: bigint;
    reason: string;
  }) => Promise<{ outcome: string }>;
}

export async function executeDanaCashback(
  executor: DanaCashbackExecutor,
  params: CashbackCreditParams,
  intent: DanaCashbackIntent,
): Promise<{ outcome: string }> {
  return executor.releaseFunds({
    idempotencyKey: danaCashbackKey(params.orderDbId),
    scope: EscrowDisbursementScope.CASHBACK,
    sellerId: intent.userId, // penerima payout
    amountSen: intent.amountSen,
    reason: `Campaign cashback order ${params.orderPublicId} voucher ${intent.voucherCode ?? '-'}`,
  });
}
