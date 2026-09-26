import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { AuditAction, InsuranceClaimStatus, Prisma } from '@prisma/client';
import { toIdr } from '../../../common/utils/currency.util';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { escapeLikePattern } from '../../../common/utils/search.util';

const TERMINAL_STATUSES: InsuranceClaimStatus[] = [
  InsuranceClaimStatus.PAID,
  InsuranceClaimStatus.REJECTED,
];

/**
 * Admin klaim asuransi Kahade+ (Benefit 3).
 * Kontrak path (dikonsumsi tim admin UI — JANGAN ubah):
 * - GET    /v1/admin/insurance-claims?page&limit&status
 * - PATCH  /v1/admin/insurance-claims/:id {status, note?}
 */
@Injectable()
export class AdminInsuranceClaimsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

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

    const updated = await this.prisma.insuranceClaim.update({
      where: { id: claimId },
      data: {
        status: status as InsuranceClaimStatus,
        ...(note !== undefined ? { note: note.trim() || null } : {}),
      },
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
}
