import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { InsuranceClaimStatus } from '@prisma/client';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';
import { toIdr, toSen } from '../../common/utils/currency.util';
import { INSURANCE_DEFAULT_CAP_IDR } from '../../common/constants/app.constants';
import * as ErrorCodes from '../../common/constants/error-codes';
import { CreateInsuranceClaimDto } from './dto/insurance-claim.dto';

/**
 * Benefit 3 Kahade+ — Asuransi.
 *
 * Syarat & cap detail menyusul dari tim produk; field-nya (claimType, amount,
 * cap, status, note) disiapkan di sini. Pengajuan klaim hanya untuk subscriber
 * aktif (dicek via SubscriptionsService.isActive — source of truth).
 */
@Injectable()
export class InsuranceService {
  private readonly logger = new Logger(InsuranceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  async createClaim(userId: string, dto: CreateInsuranceClaimDto): Promise<Record<string, unknown>> {
    const active = await this.subscriptionsService.isActive(userId);
    if (!active) {
      throw new ForbiddenException({
        code: ErrorCodes.INSURANCE_SUBSCRIPTION_REQUIRED,
        message: 'Pengajuan klaim asuransi hanya tersedia untuk pelanggan Kahade+ aktif',
      });
    }

    const amountSen = toSen(dto.amount);
    const capSen = toSen(INSURANCE_DEFAULT_CAP_IDR);
    const finalAmount = amountSen > capSen ? capSen : amountSen;

    // Batch 1-money (INS-002): orderId tidak boleh fiktif/milik orang lain.
    // orderId di sini adalah ID publik order (format ORD-YYYYMMDD-SERIAL).
    const normalizedOrderId = dto.orderId?.trim() || null;
    if (normalizedOrderId) {
      const order = await this.prisma.order.findUnique({
        where: { orderId: normalizedOrderId },
        select: { id: true, buyerId: true, sellerId: true, status: true },
      });
      if (!order) {
        throw new NotFoundException({
          code: ErrorCodes.ORDER_NOT_FOUND,
          message: 'Order terkait tidak ditemukan',
        });
      }
      if (order.buyerId !== userId && order.sellerId !== userId) {
        throw new ForbiddenException({
          code: ErrorCodes.ORDER_NOT_FOUND,
          message: 'Order tersebut bukan milik Anda',
        });
      }
      // NOTE: aturan kelayakan produk (status order yang eligible, jendela
      // waktu klaim) belum didefinisikan tim produk — gerbangnya tetap review
      // admin. Jangan mengada-ada aturan di sini.
    }

    const claim = await this.prisma.insuranceClaim.create({
      data: {
        userId,
        orderId: normalizedOrderId,
        claimType: dto.claimType.trim().toUpperCase(),
        amount: finalAmount,
        cap: capSen,
        status: InsuranceClaimStatus.DRAFT,
      },
    });

    this.logger.log(`Insurance claim ${claim.id} dibuat oleh user ${userId} (${dto.claimType})`);
    return this.serialize(claim);
  }

  /**
   * Batch 1-money (SP-005): user mengajukan klaim DRAFT-nya untuk direview.
   * Melengkapi rantai DRAFT → SUBMITTED → APPROVED → PAID.
   */
  async submitClaim(userId: string, claimId: string): Promise<Record<string, unknown>> {
    const claim = await this.prisma.insuranceClaim.findFirst({
      where: { id: claimId, userId },
    });
    if (!claim) {
      throw new NotFoundException({
        code: ErrorCodes.INSURANCE_CLAIM_NOT_FOUND,
        message: 'Klaim asuransi tidak ditemukan',
      });
    }
    if (claim.status !== InsuranceClaimStatus.DRAFT) {
      throw new ForbiddenException({
        code: ErrorCodes.INSURANCE_INVALID_STATUS,
        message: `Klaim dengan status ${claim.status} tidak dapat diajukan ulang`,
      });
    }
    const updated = await this.prisma.insuranceClaim.update({
      where: { id: claimId },
      data: { status: InsuranceClaimStatus.SUBMITTED },
    });
    this.logger.log(`Insurance claim ${claimId} diajukan (SUBMITTED) oleh user ${userId}`);
    return this.serialize(updated);
  }

  async listClaims(
    userId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const safePage = Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1);
    const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
    const skip = (safePage - 1) * safeLimit;

    const [data, total] = await Promise.all([
      this.prisma.insuranceClaim.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
      this.prisma.insuranceClaim.count({ where: { userId } }),
    ]);

    return createPaginatedResponse(data.map(c => this.serialize(c)), total, safePage, safeLimit);
  }

  async getClaim(userId: string, claimId: string): Promise<Record<string, unknown>> {
    const claim = await this.prisma.insuranceClaim.findFirst({
      where: { id: claimId, userId },
    });
    if (!claim) {
      throw new NotFoundException({
        code: ErrorCodes.INSURANCE_CLAIM_NOT_FOUND,
        message: 'Klaim asuransi tidak ditemukan',
      });
    }
    return this.serialize(claim);
  }

  private serialize(claim: {
    id: string;
    userId: string;
    orderId: string | null;
    claimType: string;
    amount: bigint;
    cap: bigint;
    status: InsuranceClaimStatus;
    note: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): Record<string, unknown> {
    return {
      id: claim.id,
      orderId: claim.orderId,
      claimType: claim.claimType,
      amount: toIdr(claim.amount),
      cap: toIdr(claim.cap),
      status: claim.status,
      note: claim.note,
      createdAt: claim.createdAt,
      updatedAt: claim.updatedAt,
    };
  }
}
