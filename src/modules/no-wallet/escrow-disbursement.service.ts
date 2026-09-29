import { Injectable, Logger } from '@nestjs/common';
import { EscrowDisbursementScope, EscrowDisbursementStatus, NotificationType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DanaDisbursementService } from '../payment/dana/dana-disbursement.service';
import { WalletModeService } from '../wallet-mode/wallet-mode.service';
import { NotificationQueueService } from '../queue/notification-queue.service';
import { decryptAES } from '../../common/utils/crypto.util';

export type ReleaseResult =
  | { outcome: 'RELEASED'; disbursementId: string; danaReferenceNo: string | null }
  | { outcome: 'PENDING'; disbursementId: string }
  | { outcome: 'HELD_NO_BANK'; disbursementId: string };

export interface ReleaseFundsParams {
  idempotencyKey: string;
  scope: EscrowDisbursementScope;
  scopeRefId?: string;
  orderId?: string;
  sellerId: string;
  amountSen: bigint;
  reason: string;
}

/**
 * Pemetaan BankCode internal → kode bank SNAP DANA (3 digit).
 * Kode ini pengetahuan publik perbankan Indonesia (BI FAST/SKNBI).
 * Bank tanpa pemetaan → fail-closed (tidak ada transfer).
 */
export const BANK_CODE_TO_SNAP: Record<string, string> = {
  BCA: '014',
  BNI: '009',
  BRI: '002',
  MANDIRI: '008',
  CIMB: '022',
  PERMATA: '013',
  DANAMON: '011',
  OCBC: '028',
  PANIN: '019',
  MEGA: '426',
  BTN: '200',
  BSI: '451',
  MAYBANK: '016',
};

/**
 * Pencairan escrow ke rekening BANK seller (mode tanpa-wallet).
 *
 * Prasyarat keamanan (BI-safe, fail-closed):
 * - Seller WAJIB punya rekening bank terdaftar & terverifikasi (primary).
 *   Belum punya → status HELD_NO_BANK + notifikasi ke seller.
 * - Bank account inquiry DANA dijalankan SEBELUM transfer; bila nama
 *   penerima tidak cocok → batal (tanpa transfer).
 * - partnerReferenceNo DANA stabil dari idempotencyKey → retry aman.
 * - DANA payout ke SALDO tidak pernah dipanggil (kecuali via legacy
 *   service yang terpisah untuk program loyalitas/promo, bukan escrow).
 */
@Injectable()
export class EscrowDisbursementService {
  private readonly logger = new Logger(EscrowDisbursementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly danaDisbursement: DanaDisbursementService,
    private readonly walletMode: WalletModeService,
    private readonly notificationQueue: NotificationQueueService,
  ) {}

  /**
   * Release escrow untuk order yang sudah COMPLETED. Idempoten.
   *
   * PENTING (akuntansi): yang dicairkan = sellerReceiveAmount (nilai order
   * bersih), BUKAN buyerPayAmount. Selisihnya (platform fee) tertahan di akun
   * merchant DANA — konsisten dengan wallet-mode (FEE_DEDUCT).
   */
  async releaseForOrder(orderDbId: string): Promise<ReleaseResult> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderDbId },
      select: {
        id: true,
        status: true,
        sellerId: true,
        sellerReceiveAmount: true,
      },
    });
    if (!order || (order.status as string) !== 'COMPLETED') {
      throw new Error('ORDER_NOT_RELEASE_ELIGIBLE');
    }
    // Fail-closed: tanpa sellerReceiveAmount yang valid, jangan cairkan apa pun.
    if (order.sellerReceiveAmount == null || order.sellerReceiveAmount <= BigInt(0)) {
      throw new Error('ORDER_NOT_RELEASE_ELIGIBLE');
    }
    return this.releaseFunds({
      idempotencyKey: `ORDER:${order.id}`,
      scope: EscrowDisbursementScope.ORDER_ESCROW,
      orderId: order.id,
      sellerId: order.sellerId,
      amountSen: order.sellerReceiveAmount,
      reason: `Cair escrow order ${order.id}`,
    });
  }

  /** Release dana generik (order/milestone/rebate dsb.). Idempoten. */
  async releaseFunds(params: ReleaseFundsParams): Promise<ReleaseResult> {
    const existing = await this.prisma.escrowDisbursement.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
    });
    if (existing) {
      if (existing.status === EscrowDisbursementStatus.SUCCESS) {
        return { outcome: 'RELEASED', disbursementId: existing.id, danaReferenceNo: existing.danaReferenceNo };
      }
      if (existing.status === EscrowDisbursementStatus.HELD_NO_BANK) {
        return { outcome: 'HELD_NO_BANK', disbursementId: existing.id };
      }
      // PROCESSING / FAILED / CANCELLED → coba reconcile/ulang di bawah
      return this.settle(existing);
    }

    const row = await this.prisma.escrowDisbursement.create({
      data: {
        idempotencyKey: params.idempotencyKey,
        scope: params.scope,
        scopeRefId: params.scopeRefId ?? null,
        orderId: params.orderId ?? null,
        sellerId: params.sellerId,
        amountSen: params.amountSen,
        status: EscrowDisbursementStatus.PENDING,
      },
    });
    return this.settle(row);
  }

  /** Retry scheduler: proses baris PENDING/FAILED yang belum sukses. */
  async retryDue(limit = 50): Promise<number> {
    const due = await this.prisma.escrowDisbursement.findMany({
      where: {
        status: { in: [EscrowDisbursementStatus.PENDING, EscrowDisbursementStatus.FAILED] },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    let settled = 0;
    for (const row of due) {
      try {
        const res = await this.settle(row);
        if (res.outcome === 'RELEASED') settled++;
      } catch (e) {
        this.logger.warn(`Retry disbursement gagal: key=${row.idempotencyKey}: ${(e as Error).message}`);
      }
    }
    return settled;
  }

  private async settle(
    row: { id: string; idempotencyKey: string; sellerId: string; amountSen: bigint; danaPartnerReferenceNo: string | null },
  ): Promise<ReleaseResult> {
    // 1) Rekening bank seller wajib ada (primary, tidak dihapus)
    const bank = await this.prisma.bankAccount.findFirst({
      where: { userId: row.sellerId, isPrimary: true, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (!bank) {
      const held = await this.prisma.escrowDisbursement.update({
        where: { id: row.id },
        data: {
          status: EscrowDisbursementStatus.HELD_NO_BANK,
          heldReason: 'Seller belum mendaftarkan rekening bank — dana escrow ditahan sampai rekening terdaftar',
        },
      });
      await this.notificationQueue.enqueue({
        type: NotificationType.ESCROW_HELD_NO_BANK,
        userId: row.sellerId,
        title: 'Daftarkan rekening bank',
        body: 'Dana escrow menunggu dicairkan — daftarkan rekening bank Anda agar dana masuk otomatis.',
      });
      this.logger.warn(`Disbursement HELD_NO_BANK: seller=${row.sellerId} key=${row.idempotencyKey}`);
      return { outcome: 'HELD_NO_BANK', disbursementId: held.id };
    }

    // 2) Decrypt data rekening (fail-closed bila gagal decrypt)
    let accountNumber: string;
    let accountName: string;
    try {
      [accountNumber, accountName] = await Promise.all([
        decryptAES(bank.accountNumber),
        decryptAES(bank.accountName),
      ]);
    } catch (e) {
      return this.fail(row, `DECRYPT_FAILED: ${(e as Error).message}`);
    }

    const amountIdr = Number(row.amountSen) / 100;
    if (!Number.isInteger(amountIdr) || amountIdr <= 0) {
      return this.fail(row, `INVALID_AMOUNT_SEN: ${row.amountSen}`);
    }

    // Kode bank SNAP DANA — fail-closed bila bank tidak terpetakan.
    const snapCode = BANK_CODE_TO_SNAP[bank.bankCode];
    if (!snapCode) {
      return this.fail(row, `BANK_CODE_UNMAPPED: ${bank.bankCode}`);
    }

    // 3) Bank account inquiry — verifikasi nama penerima (anti salah transfer)
    const partnerRef = (row.danaPartnerReferenceNo ?? this.makePartnerRef(row.idempotencyKey)).slice(0, 32);
    try {
      const inquiry = await this.danaDisbursement.bankAccountInquiry({
        partnerReferenceNo: `INQ-${partnerRef}`,
        beneficiaryAccountNumber: accountNumber,
        beneficiaryBankCode: snapCode,
        amountIdr,
      });
      if (!inquiry.verified) {
        return this.fail(row, `BANK_INQUIRY_NOT_VERIFIED: ${snapCode}`);
      }
      const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').trim();
      const registered = normalize(accountName);
      const returned = normalize(inquiry.accountName ?? '');
      if (returned && registered && returned !== registered) {
        return this.fail(
          row,
          `BANK_ACCOUNT_NAME_MISMATCH: terdaftar="${registered}" inquiry="${returned}"`,
        );
      }
      await this.prisma.escrowDisbursement.update({
        where: { id: row.id },
        data: { danaPartnerReferenceNo: partnerRef, bankAccountId: bank.id },
      });
    } catch (e) {
      return this.fail(row, `BANK_INQUIRY_ERROR: ${(e as Error).message}`);
    }

    // 4) Transfer ke bank (idempoten via partnerReferenceNo stabil)
    try {
      const transfer = await this.danaDisbursement.transferToBank({
        partnerReferenceNo: partnerRef,
        beneficiaryAccountNumber: accountNumber,
        beneficiaryBankCode: snapCode,
        beneficiaryAccountName: accountName,
        amountIdr,
      });
      if (transfer.status === 'SUCCESS') {
        const done = await this.prisma.escrowDisbursement.update({
          where: { id: row.id },
          data: {
            status: EscrowDisbursementStatus.SUCCESS,
            danaReferenceNo: transfer.referenceNo,
            danaPartnerReferenceNo: partnerRef,
            bankAccountId: bank.id,
            releasedAt: new Date(),
          },
        });
        this.logger.log(`Disbursement sukses: key=${row.idempotencyKey} ref=${transfer.referenceNo}`);
        return { outcome: 'RELEASED', disbursementId: done.id, danaReferenceNo: transfer.referenceNo };
      }
      await this.prisma.escrowDisbursement.update({
        where: { id: row.id },
        data: {
          status: EscrowDisbursementStatus.PROCESSING,
          danaReferenceNo: transfer.referenceNo,
          danaPartnerReferenceNo: partnerRef,
          bankAccountId: bank.id,
        },
      });
      return { outcome: 'PENDING', disbursementId: row.id };
    } catch (e) {
      return this.fail(row, `TRANSFER_ERROR: ${(e as Error).message}`);
    }
  }

  private async fail(
    row: { id: string; idempotencyKey: string },
    lastError: string,
  ): Promise<ReleaseResult> {
    const updated = await this.prisma.escrowDisbursement.update({
      where: { id: row.id },
      data: { status: EscrowDisbursementStatus.FAILED, lastError, attemptCount: { increment: 1 } },
    });
    this.logger.warn(`Disbursement gagal: key=${row.idempotencyKey}: ${lastError}`);
    return { outcome: 'PENDING', disbursementId: updated.id };
  }

  private makePartnerRef(idempotencyKey: string): string {
    const clean = idempotencyKey.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return `DSB-${clean}`.slice(0, 32);
  }

  /**
   * Query status disbursement untuk user (cashback, referral, order escrow, dll).
   * Dipakai frontend untuk menampilkan status pencairan ke user.
   */
  async getDisbursementsForUser(
    userId: string,
    opts: { scope?: EscrowDisbursementScope; limit?: number } = {},
  ): Promise<
    Array<{
      id: string;
      scope: EscrowDisbursementScope;
      scopeRefId: string | null;
      orderId: string | null;
      amountSen: string;
      status: EscrowDisbursementStatus;
      heldReason: string | null;
      lastError: string | null;
      danaReferenceNo: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>
  > {
    const rows = await this.prisma.escrowDisbursement.findMany({
      where: {
        sellerId: userId,
        ...(opts.scope ? { scope: opts.scope } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts.limit ?? 20, 100),
      select: {
        id: true,
        scope: true,
        scopeRefId: true,
        orderId: true,
        amountSen: true,
        status: true,
        heldReason: true,
        lastError: true,
        danaReferenceNo: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return rows.map((r) => ({ ...r, amountSen: r.amountSen.toString() }));
  }
}
