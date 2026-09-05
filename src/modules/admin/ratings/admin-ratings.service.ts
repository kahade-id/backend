import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { createPaginatedResponse, PaginatedResponse } from '../../../common/dto/pagination.dto';
import { AuditAction, Prisma } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';

@Injectable()
export class AdminRatingsService {
  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
  ) {}

  async listRatings(page: number, limit: number, stars?: string, flagged?: string): Promise<PaginatedResponse<Record<string, unknown>>> {
    if (stars !== undefined && !['1', '2', '3', '4', '5'].includes(stars)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'stars must be between 1 and 5' });
    }
    if (flagged !== undefined && flagged !== 'true' && flagged !== 'false') {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'flagged must be true or false' });
    }
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
    const skip = (safePage - 1) * safeLimit;

    const where: Prisma.RatingWhereInput = {};
    if (stars) {
      const parsed = parseInt(stars, 10);
      if (!isNaN(parsed) && parsed >= 1 && parsed <= 5) {
        where.stars = parsed;
      }
    }
    if (flagged === 'true') {
      where.isHidden = true;
    }
    if (flagged === 'false') {
      where.isHidden = false;
    }

    const [ratings, total] = await Promise.all([
      this.prisma.rating.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        include: {
          giver: {
            select: {
              id: true,
              userId: true,
              username: true,
              fullName: true,
            },
          },
          receiver: {
            select: {
              id: true,
              userId: true,
              username: true,
              fullName: true,
            },
          },
          order: {
            select: {
              id: true,
              orderId: true,
            },
          },
        },
      }),
      this.prisma.rating.count({ where }),
    ]);

    return createPaginatedResponse(ratings, total, safePage, safeLimit);
  }

  async removeRating(ratingId: string, adminId: string, ipAddress: string, reason: string): Promise<{ message: string; ratingId: string }> {
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'A reason is required when modifying ratings',
      });
    }
    const rating = await this.prisma.rating.findUnique({
      where: { id: ratingId },
    });

    if (!rating) {
      throw new NotFoundException({
        code: ErrorCodes.RATING_NOT_FOUND,
        message: 'Rating not found',
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${rating.receiverId} FOR UPDATE`;
      const result = await tx.rating.updateMany({
        where: { id: ratingId, isHidden: false },
        data: { isHidden: true, hiddenAt: new Date(), hiddenBy: adminId },
      });
      if (result.count === 0) throw new ConflictException({ code: ErrorCodes.INVALID_STATUS, message: 'Rating state changed; reload and retry' });
      await this.recalcReceiverStats(tx, rating.receiverId);
      return { id: ratingId };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    await this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Rating',
      targetId: ratingId,
      description: `Removed rating ${ratingId}${reason ? ': ' + reason : ''}`,
      ipAddress,
    });

    return {
      message: 'Rating removed successfully',
      ratingId: updated.id,
    };
  }

  async unhideRating(ratingId: string, adminId: string, ipAddress: string, reason: string): Promise<{ message: string; ratingId: string }> {
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'A reason is required when modifying ratings',
      });
    }
    const rating = await this.prisma.rating.findUnique({
      where: { id: ratingId },
    });

    if (!rating) {
      throw new NotFoundException({
        code: ErrorCodes.RATING_NOT_FOUND,
        message: 'Rating not found',
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${rating.receiverId} FOR UPDATE`;
      const result = await tx.rating.updateMany({
        where: { id: ratingId, isHidden: true },
        data: { isHidden: false, hiddenAt: null, hiddenBy: null },
      });
      if (result.count === 0) throw new ConflictException({ code: ErrorCodes.INVALID_STATUS, message: 'Rating state changed; reload and retry' });
      await this.recalcReceiverStats(tx, rating.receiverId);
      return { id: ratingId };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    await this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Rating',
      targetId: ratingId,
      description: `Unhid rating ${ratingId}${reason ? ': ' + reason : ''}`,
      ipAddress,
    });

    return {
      message: 'Rating unhidden successfully',
      ratingId: updated.id,
    };
  }

  private async recalcReceiverStats(tx: Prisma.TransactionClient, receiverId: string): Promise<void> {
    const visibleRatings = await tx.rating.aggregate({
      where: { receiverId, isHidden: false },
      _avg: { stars: true },
      _count: { stars: true },
    });
    await tx.user.update({
      where: { id: receiverId },
      data: {
        averageRating: visibleRatings._avg.stars ?? 0,
        totalRatingCount: visibleRatings._count.stars,
      },
    });
  }
}
