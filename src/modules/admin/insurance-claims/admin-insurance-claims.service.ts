import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import {
  AdminRole,
  AuditAction,
  InsuranceClaimStatus,
  NotificationType,
  Prisma,
  WalletTransactionStatus,
  WalletTransactionType,
} from '@prisma/client';
import { toIdr, formatSen } from '../../../common/utils/currency.util';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { escapeLikePattern } from '../../../common/utils/search.util';
import { generateNotifId, generateWalletTxId } from '../../../common/utils/id-generator.util';
import { getCategoryForType } from '../../notifications/notification-category.map';
// SEC-502: pembayaran klaim SELALU via dual control (maker-checker).
import { ApprovalsService } from '../approvals/approvals.service';

const TERMINAL_STATUSES: InsuranceClaimStatus[] = [
  InsuranceClaimStatus.PAID,
  InsuranceClaimStatus.REJECTED,
];

/**
 * Batch 1-money (INS-003): peta transisi status yang diizinkan.
 * Sebelumnya guard hanya blacklist status terminal sehingga DRAFT bisa
 * langsung loncat ke PAID tanpa persetujuan.
 */
const ALLOWED_TRANSITIONS: Record<string, InsuranceClaimStatus[]> = {
  // ADM-209: DRAFT DIHAPUS dari transisi APPROVED. Klaim yang belum disubmit
  // user tidak boleh di-approve (apalagi dibayar) admin — proteksi tidak boleh
  // hanya di client. REJECTED dari DRAFT tetap diizinkan (tidak menggerakkan uang).
  APPROVED: [InsuranceClaimStatus.SUBMITTED],
  REJECTED: [
    InsuranceClaimStatus.DRAFT,
    InsuranceClaimStatus.SUBMITTED,
    InsuranceClaimStatus.APPROVED,
  ],
  // PAID hanya dari APPROVED — di sinilah payout atomik (INS-001) berjalan.
  PAID: [InsuranceClaimStatus.APPROVED],
};

/**
 * Admin klaim asuransi Kahade+ (Benefit 3).
 * Kontrak path (dikonsumsi tim admin UI — JANGAN ubah):
 * - GET    /v1/admin/insurance-claims?page&limit&status
 * - PATCH  /v1/admin/insurance-claims/:id {status, note?}
 */
@Injectable()
export class AdminInsuranceClaimsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly walletTxSerial: WalletTxSerialService,
    // SEC-502: modul ini mengeksekusi INSURANCE_CLAIM_PAY yang disetujui.
    private readonly approvals: ApprovalsService,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('INSURANCE_CLAIM_PAY', async (ctx) => {
      if (!ctx.targetId) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'INSURANCE_CLAIM_PAY membutuhkan targetId (claimId)',
        });
      }
      const note =
        typeof ctx.payload.note === 'string' ? (ctx.payload.note as string) : undefined;
      // paidBy (decidedBy) != approvedBy (proposedBy) dijamin guard SELF_APPROVAL;
      // dicatat eksplisit di audit trail.
      return this.payApprovedClaim(ctx.targetId, note, ctx.decidedBy, ctx.proposedBy, ctx.ipAddress);
    });
  }

  async listClaims(page: number, limit: number, status?: string, search?: string): Promise<object> {
    const safePage = Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1);
    const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
    const skip = (safePage - 1) * safeLimit;

    const where: Prisma.InsuranceClaimWhereInput = {};
    if (status) where.status = status as InsuranceClaimStatus;
    const normalizedSearch = search?.trim();
    if (normalizedSearch) {
      const pattern = escapeLikePattern(normalizedSearch);
      where.OR = [
        { userId: { contains: pattern, mode: 'insensitive' } },
        { claimType: { contains: pattern, mode: 'insensitive' } },
        { orderId: { contains: pattern, mode: 'insensitive' } },
      ];
    }

    const [claims, total] = await Promise.all([
      this.prisma.insuranceClaim.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, userId: true, username: true, fullName: true, email: true } },
        },
      }),
      this.prisma.insuranceClaim.count({ where }),
    ]);

    const data = claims.map(c => ({
      ...c,
      amount: toIdr(c.amount),
      cap: toIdr(c.cap),
    }));
    return createPaginatedResponse(data, total, safePage, safeLimit);
  }

  async reviewClaim(
    claimId: string,
    status: 'APPROVED' | 'REJECTED' | 'PAID',
    note: string | undefined,
    adminId: string,
    adminRole: AdminRole,
    ipAddress: string,
  ): Promise<object> {
    const claim = await this.prisma.insuranceClaim.findUnique({ where: { id: claimId } });
    if (!claim) {
      throw new NotFoundException({
        code: ErrorCodes.INSURANCE_CLAIM_NOT_FOUND,
        message: 'Klaim asuransi tidak ditemukan',
      });
    }
    if (TERMINAL_STATUSES.includes(claim.status)) {
      throw new BadRequestException({
        code: ErrorCodes.INSURANCE_INVALID_STATUS,
        message: `Klaim dengan status ${claim.status} tidak dapat diubah lagi`,
      });
    }

    // INS-003: hanya transisi yang terdaftar yang diizinkan.
    const allowedFrom = ALLOWED_TRANSITIONS[status] ?? [];
    if (!allowedFrom.includes(claim.status)) {
      throw new BadRequestException({
        code: ErrorCodes.INSURANCE_INVALID_STATUS,
        message: `Transisi status ${claim.status} → ${status} tidak diizinkan`,
      });
    }

    // INS-001: PAID harus menggerakkan uang — payout atomik + idempoten.
    // Klaim yang sudah PAID/berubah status di tengah jalan ditolak agar
    // tidak terjadi double-credit.
    // SEC-502: PAID SELALU via dual control — endpoint ini hanya MEMBUAT
    // usulan PENDING (tidak mengeksekusi). Eksekusi terjadi saat admin KEDUA
    // menyetujui via POST /v1/admin/approvals/:id/approve.
    if (status === 'PAID') {
      const approval = await this.approvals.propose({
        actionType: 'INSURANCE_CLAIM_PAY',
        targetId: claimId,
        payload: { note: note ?? null },
        amountSen: Number(claim.amount),
        // Idempoten per klaim: PATCH PAID ulang mengembalikan approval yang ada.
        idempotencyKey: `insurance-pay:${claimId}`,
        proposedBy: adminId,
        proposerRole: adminRole,
        ipAddress,
      });
      return {
        approvalId: approval.approvalId,
        status: approval.status,
        expiresAt: approval.expiresAt,
        message:
          'Usulan pembayaran klaim dibuat — butuh persetujuan admin kedua ' +
          '(POST /v1/admin/approvals/:id/approve). paidBy wajib berbeda dari pengusul.',
      };
    }

    // CW-008/SP-018: keputusan APPROVED/REJECTED diberitahukan ke pengaju.
    // Update status + notifikasi dalam satu transaksi agar tidak ada keputusan
    // tanpa notifikasi. Guard transisi di atas membuat retry aman (tidak ada
    // notifikasi ganda): APPROVED→APPROVED / REJECTED→REJECTED ditolak.
    // Tipe khusus INSURANCE_CLAIM_* butuh migrasi enum — sementara pakai
    // SYSTEM_ANNOUNCEMENT dengan judul/isi yang eksplisit.
    const notifTitle =
      status === 'APPROVED' ? 'Klaim asuransi disetujui' : 'Klaim asuransi ditolak';
    const notifBody =
      status === 'APPROVED'
        ? `Klaim asuransi Anda (${claim.claimType}) telah disetujui admin. Pembayaran akan diproses ke wallet Anda.`
        : `Klaim asuransi Anda (${claim.claimType}) ditolak admin.${note ? ` Alasan: ${note.trim()}` : ' Hubungi dukungan untuk informasi lebih lanjut.'}`;

    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedClaim = await tx.insuranceClaim.update({
        where: { id: claimId },
        data: {
          status: status as InsuranceClaimStatus,
          ...(note !== undefined ? { note: note.trim() || null } : {}),
        },
      });
      const notifType = NotificationType.SYSTEM_ANNOUNCEMENT;
      await tx.notification.create({
        data: {
          notifId: generateNotifId(),
          userId: claim.userId,
          type: notifType,
          category: getCategoryForType(notifType),
          title: notifTitle,
          body: notifBody,
          isRead: false,
        },
      });
      return updatedClaim;
    });

    // SP-018 (lanjutan): dorong realtime/push seperti pola admin-support —
    // emitNotificationCreated bersifat best-effort (error ditangkap di dalam).
    this.prisma.emitNotificationCreated({
      userId: claim.userId,
      title: notifTitle,
      body: notifBody,
      data: { type: 'INSURANCE_CLAIM_UPDATE', claimId },
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'InsuranceClaim',
      targetId: claimId,
      description: `Mengubah status klaim asuransi ${claimId} dari ${claim.status} menjadi ${status}`,
      ipAddress,
    });

    return {
      ...updated,
      amount: toIdr(updated.amount),
      cap: toIdr(updated.cap),
    };
  }

  /**
   * SEC-502: eksekusi pembayaran klaim HANYA dipanggil dari executor
   * INSURANCE_CLAIM_PAY setelah approval dual control (bukan dari endpoint
   * langsung). paidBy (decidedBy) != proposedBy dijamin guard SELF_APPROVAL
   * di ApprovalsService dan dicatat eksplisit di audit trail.
   */
  async payApprovedClaim(
    claimId: string,
    note: string | undefined,
    decidedBy: string,
    proposedBy: string,
    ipAddress: string,
  ): Promise<object> {
    const claim = await this.prisma.insuranceClaim.findUnique({ where: { id: claimId } });
    if (!claim) {
      throw new NotFoundException({
        code: ErrorCodes.INSURANCE_CLAIM_NOT_FOUND,
        message: 'Klaim asuransi tidak ditemukan',
      });
    }
    const result = await this.payClaim(claimId, note, decidedBy, ipAddress, {
      id: claim.id,
      userId: claim.userId,
      status: claim.status,
      amount: claim.amount,
      claimType: claim.claimType,
    });
    this.auditLog.logAdminAction({
      adminId: decidedBy,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'InsuranceClaim',
      targetId: claimId,
      description:
        `Dual control INSURANCE_CLAIM_PAY: diusulkan ${proposedBy}, ` +
        `disetujui+dibayar (paidBy) ${decidedBy}`,
      ipAddress,
    });
    return result;
  }

  /**
   * INS-001: bayar klaim asuransi — kredit wallet user + jurnal ledger +
   * status PAID + notifikasi, semua dalam satu transaksi Serializable.
   *
   * Idempotensi berlapis:
   * - Guard `updateMany({ where: { id, status: APPROVED } })` pada klaim:
   *   bila 0 baris terpengaruh, klaim sudah diproses/diubah → Conflict.
   * - OCC `version` pada wallet: bila 0 baris terpengaruh → Conflict, retry.
   * - `txId` unik dari WalletTxSerialService (kolom unique di DB).
   */
  private async payClaim(
    claimId: string,
    note: string | undefined,
    adminId: string,
    ipAddress: string,
    claim: { id: string; userId: string; status: InsuranceClaimStatus; amount: bigint; claimType: string },
  ): Promise<object> {
    // Serial dibuat sebelum transaksi (pola adjustWallet): rollback tidak
    // membuat lubang serial yang fatal, hanya gap nomor urut.
    const txId = generateWalletTxId(await this.walletTxSerial.getNext());
    const amountSen = claim.amount;
    if (amountSen <= BigInt(0)) {
      throw new BadRequestException({
        code: ErrorCodes.INSURANCE_INVALID_STATUS,
        message: 'Nominal klaim tidak valid untuk dibayarkan',
      });
    }

    let paidClaim!: { id: string; status: InsuranceClaimStatus; amount: bigint; cap: bigint; note: string | null; createdAt: Date; updatedAt: Date; orderId: string | null; claimType: string; userId: string };

    await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        // 1. Klaim status → PAID hanya bila masih APPROVED (idempotency guard).
        const claimed = await tx.insuranceClaim.updateMany({
          where: { id: claimId, status: InsuranceClaimStatus.APPROVED },
          data: {
            status: InsuranceClaimStatus.PAID,
            ...(note !== undefined ? { note: note.trim() || null } : {}),
          },
        });
        if (claimed.count === 0) {
          throw new ConflictException({
            code: ErrorCodes.INSURANCE_INVALID_STATUS,
            message: 'Klaim sudah diproses atau statusnya berubah; payout dibatalkan',
          });
        }

        // 2. Wallet user — tolak bila terkunci (admin harus unlock dulu).
        const wallet = await tx.wallet.findUnique({ where: { userId: claim.userId } });
        if (!wallet) {
          throw new NotFoundException({
            code: ErrorCodes.WALLET_NOT_FOUND,
            message: 'Wallet user tidak ditemukan',
          });
        }
        if (wallet.isLocked) {
          throw new BadRequestException({
            code: ErrorCodes.WALLET_LOCKED,
            message: `Wallet terkunci${wallet.lockReason ? `: ${wallet.lockReason}` : ''}. Buka kunci wallet sebelum membayar klaim.`,
          });
        }

        const balanceBefore = wallet.availableBalance;
        const balanceAfter = wallet.availableBalance + amountSen;

        const walletUpdated = await tx.wallet.updateMany({
          where: { id: wallet.id, version: wallet.version },
          data: {
            availableBalance: balanceAfter,
            totalBalance: wallet.totalBalance + amountSen,
            version: { increment: 1 },
          },
        });
        if (walletUpdated.count === 0) {
          throw new ConflictException({
            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
            message: 'Concurrent wallet update detected, please retry',
          });
        }

        // 3. Jurnal ledger — ADMIN_CREDIT (preseden: adjustWallet admin).
        await tx.walletTransaction.create({
          data: {
            txId,
            walletId: wallet.id,
            type: WalletTransactionType.ADMIN_CREDIT,
            status: WalletTransactionStatus.SUCCESS,
            amount: amountSen,
            balanceBefore,
            balanceAfter,
            description: `Pembayaran klaim asuransi ${claimId} (${claim.claimType})`,
          },
        });

        // 4. Notifikasi ke user.
        const notifType = NotificationType.WALLET_TOPUP_SUCCESS;
        await tx.notification.create({
          data: {
            notifId: generateNotifId(),
            userId: claim.userId,
            type: notifType,
            category: getCategoryForType(notifType),
            title: 'Klaim asuransi dibayar',
            body: `Klaim asuransi Anda sebesar ${formatSen(amountSen)} telah dibayarkan ke saldo wallet.`,
            isRead: false,
          },
        });

        const fresh = await tx.insuranceClaim.findUnique({ where: { id: claimId } });
        if (!fresh) {
          throw new NotFoundException({
            code: ErrorCodes.INSURANCE_CLAIM_NOT_FOUND,
            message: 'Klaim asuransi tidak ditemukan',
          });
        }
        paidClaim = fresh;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'InsuranceClaim',
      targetId: claimId,
      description: `Membayar klaim asuransi ${claimId} (${toIdr(amountSen)} IDR) ke wallet user ${claim.userId}; ledger ${txId}`,
      ipAddress,
    });

    return {
      ...paidClaim,
      amount: toIdr(paidClaim.amount),
      cap: toIdr(paidClaim.cap),
    };
  }
}
