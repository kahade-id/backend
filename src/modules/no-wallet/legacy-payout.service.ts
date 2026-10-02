import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  EscrowDisbursementScope,
  EscrowDisbursementStatus,
  Prisma,
  WalletTransactionStatus,
  WalletTransactionType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { generateWalletTxId } from '../../common/utils/id-generator.util';
import { EscrowDisbursementService } from './escrow-disbursement.service';
import { WalletService } from '../wallet/wallet.service';
import { LegacyPayoutDto } from './dto/legacy-payout.dto';

export interface LegacyPayoutResult {
  status: 'RELEASED' | 'PENDING' | 'HELD_NO_BANK';
  walletTxId: string;
  disbursementId: string;
  danaReferenceNo: string | null;
  amountSen: string;
}

/**
 * Payout SATU ARAH saldo wallet lama ke rekening bank seller via DANA.
 *
 * - Tetap hidup saat WALLET_ENABLED=false (controller ini TIDAK memakai
 *   WalletKillSwitchGuard — justru ini jalur keluarnya saldo lama).
 * - TIDAK ada top-up / transfer masuk / kredit ke wallet dari jalur ini.
 * - PIN wallet wajib (fail-closed).
 * - Debit saldo atomik dalam 1 transaksi; idempoten via idempotencyKey
 *   klien (disimpan di WalletTransaction.metadata) dan via
 *   EscrowDisbursement.idempotencyKey.
 * - Bila rekening belum ada saat release (race) → debit dibatalkan via
 *   transaksi kompensasi (ADMIN_CREDIT) + original REVERSED — saldo utuh.
 */
@Injectable()
export class LegacyPayoutService {
  private readonly logger = new Logger(LegacyPayoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly escrowDisbursement: EscrowDisbursementService,
    private readonly serial: WalletTxSerialService,
  ) {}

  async requestPayout(userId: string, dto: LegacyPayoutDto, ip?: string): Promise<LegacyPayoutResult> {
    const amountSen = BigInt(dto.amountSen);
    if (amountSen <= 0n) {
      throw new BadRequestException({ code: 'INVALID_AMOUNT', message: 'Nominal payout harus positif' });
    }

    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException({ code: 'WALLET_NOT_FOUND', message: 'Wallet tidak ditemukan' });

    // PIN wajib — fail-closed (termasuk rate-limit di dalamnya).
    await this.walletService.verifyPin(userId, dto.pin, ip);

    // Rekening bank wajib ada sebelum debit — fail fast, tanpa menyentuh saldo.
    const bank = await this.prisma.bankAccount.findFirst({
      where: { userId, isPrimary: true, deletedAt: null },
    });
    if (!bank) {
      throw new ServiceUnavailableException({
        code: 'LEGACY_PAYOUT_NO_BANK',
        message: 'Daftarkan rekening bank terlebih dahulu untuk mencairkan saldo lama Anda',
      });
    }

    const clientKey = dto.idempotencyKey?.trim() || null;

    // 1) Debit atomik (idempoten bila clientKey diulang)
    // SEC-203: idempotency via KOLOM idempotencyKey + unique constraint
    // (klaim atomik saat insert), BUKAN read-check-then-write di metadata JSON
    // — dua request konkuren dengan key sama tidak bisa double-debit: yang
    // kalah kena P2002 lalu membaca baris pemenang.
    const debit = await this.prisma.$transaction(async tx => {
      const w = await tx.wallet.findUnique({ where: { id: wallet.id } });
      if (!w) throw new NotFoundException({ code: 'WALLET_NOT_FOUND', message: 'Wallet tidak ditemukan' });

      if (w.availableBalance < amountSen) {
        throw new ConflictException({
          code: 'INSUFFICIENT_BALANCE',
          message: 'Saldo tersedia tidak mencukupi untuk payout',
        });
      }

      const txId = generateWalletTxId(await this.serial.getNextForPrefix('WLT'));
      let walletTx;
      try {
        walletTx = await tx.walletTransaction.create({
          data: {
            txId,
            walletId: w.id,
            type: WalletTransactionType.WITHDRAW,
            status: WalletTransactionStatus.PENDING,
            amount: amountSen,
            balanceBefore: w.availableBalance,
            balanceAfter: w.availableBalance - amountSen,
            bankAccountId: bank.id,
            description: `Legacy payout saldo lama ke rekening bank (${bank.bankName})`,
            // Kunci idempotensi dedikasi (kolom, unique) — klaim atomik.
            ...(clientKey ? { idempotencyKey: clientKey } : {}),
            metadata: clientKey ? { idempotencyKey: clientKey, kind: 'LEGACY_PAYOUT' } : { kind: 'LEGACY_PAYOUT' },
          },
        });
      } catch (e) {
        if (
          clientKey &&
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002' &&
          ((e.meta?.target as string[] | undefined)?.includes('idempotencyKey') ?? true)
        ) {
          // Pemenang sudah insert duluan — baca barisnya, jangan debit lagi.
          const existing = await tx.walletTransaction.findUnique({
            where: { idempotencyKey: clientKey },
          });
          if (existing) {
            return { walletTx: existing, fresh: false };
          }
        }
        throw e;
      }
      await tx.wallet.update({
        where: { id: w.id },
        data: {
          availableBalance: { decrement: amountSen },
          totalBalance: { decrement: amountSen },
        },
      });
      return { walletTx, fresh: true };
    });

    const walletTx = debit.walletTx;

    // Idempotency hit: kembalikan status terakhir tanpa aksi baru.
    if (!debit.fresh) {
      const disb = await this.prisma.escrowDisbursement.findUnique({
        where: { idempotencyKey: `LEGACY_PAYOUT:${walletTx.id}` },
      });
      return {
        status: this.mapStatus(walletTx.status as WalletTransactionStatus),
        walletTxId: walletTx.txId,
        disbursementId: disb?.id ?? '',
        danaReferenceNo: disb?.danaReferenceNo ?? null,
        amountSen: walletTx.amount.toString(),
      };
    }

    // 2) Release via DANA disbursement (idempoten di sisi DANA).
    const release = await this.escrowDisbursement.releaseFunds({
      idempotencyKey: `LEGACY_PAYOUT:${walletTx.id}`,
      scope: 'LEGACY_PAYOUT' as EscrowDisbursementScope,
      scopeRefId: walletTx.id,
      sellerId: userId,
      amountSen,
      reason: `Legacy payout saldo lama user ${userId}`,
    });

    if (release.outcome === 'RELEASED') {
      await this.prisma.walletTransaction.update({
        where: { id: walletTx.id },
        data: { status: WalletTransactionStatus.SUCCESS, completedAt: new Date() },
      });
      this.logger.log(`Legacy payout sukses: user=${userId} amountSen=${amountSen} ref=${release.danaReferenceNo}`);
      return {
        status: 'RELEASED',
        walletTxId: walletTx.txId,
        disbursementId: release.disbursementId,
        danaReferenceNo: release.danaReferenceNo,
        amountSen: amountSen.toString(),
      };
    }

    if (release.outcome === 'HELD_NO_BANK') {
      // Race: rekening dihapus setelah cek awal → batalkan debit via kompensasi.
      await this.reverseDebit(wallet.id, walletTx.id, amountSen, 'rekening bank dihapus sebelum transfer');
      await this.prisma.escrowDisbursement.update({
        where: { id: release.disbursementId },
        data: { status: EscrowDisbursementStatus.CANCELLED },
      });
      return {
        status: 'HELD_NO_BANK',
        walletTxId: walletTx.txId,
        disbursementId: release.disbursementId,
        danaReferenceNo: null,
        amountSen: amountSen.toString(),
      };
    }

    // PROCESSING / FAILED → walletTx tetap PENDING; retry via scheduler.
    return {
      status: 'PENDING',
      walletTxId: walletTx.txId,
      disbursementId: release.disbursementId,
      danaReferenceNo: null,
      amountSen: amountSen.toString(),
    };
  }

  /** Kompensasi: kembalikan debit (kredit penuh) + tandai original REVERSED. */
  private async reverseDebit(
    walletId: string,
    walletTxId: string,
    amountSen: bigint,
    reason: string,
  ): Promise<void> {
    await this.prisma.$transaction(async tx => {
      const w = await tx.wallet.findUnique({ where: { id: walletId } });
      if (!w) throw new NotFoundException({ code: 'WALLET_NOT_FOUND', message: 'Wallet tidak ditemukan' });
      const creditTx = await tx.walletTransaction.create({
        data: {
          txId: generateWalletTxId(await this.serial.getNextForPrefix('WLT')),
          walletId,
          type: WalletTransactionType.ADMIN_CREDIT,
          status: WalletTransactionStatus.SUCCESS,
          amount: amountSen,
          balanceBefore: w.availableBalance,
          balanceAfter: w.availableBalance + amountSen,
          description: `Reversal legacy payout: ${reason}`,
          metadata: { kind: 'LEGACY_PAYOUT_REVERSAL', reverses: walletTxId },
          completedAt: new Date(),
        },
      });
      await tx.wallet.update({
        where: { id: walletId },
        data: {
          availableBalance: { increment: amountSen },
          totalBalance: { increment: amountSen },
        },
      });
      await tx.walletTransaction.update({
        where: { id: walletTxId },
        data: { status: WalletTransactionStatus.REVERSED, reversalTxId: creditTx.id },
      });
    });
    this.logger.warn(`Legacy payout dibatalkan (kompensasi): walletTx=${walletTxId} reason=${reason}`);
  }

  private mapStatus(s: WalletTransactionStatus): LegacyPayoutResult['status'] {
    if (s === WalletTransactionStatus.SUCCESS) return 'RELEASED';
    if (s === WalletTransactionStatus.REVERSED || s === WalletTransactionStatus.CANCELLED) return 'HELD_NO_BANK';
    return 'PENDING';
  }
}
