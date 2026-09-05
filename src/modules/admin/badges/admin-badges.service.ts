import { BadRequestException, Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';
import { CreateBadgeDto, UpdateBadgeDto } from './dto/create-badge.dto';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { AuditAction, NotificationType, Prisma } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';

@Injectable()
export class AdminBadgesService {
  private readonly logger = new Logger(AdminBadgesService.name);

  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
    private notificationQueue: NotificationQueueService,
  ) {}

  async listBadges(page: number, limit: number): Promise<object> {
    const safePage = Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1);
    const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20));
    const [badges, total] = await Promise.all([
      this.prisma.badge.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        include: {
          _count: { select: { userBadges: true } },
        },
      }),
      this.prisma.badge.count(),
    ]);

    const data = badges.map((b) => ({
      ...b,
      awardedCount: b._count.userBadges,
      holderCount: b._count.userBadges,
    }));

    return createPaginatedResponse(data, total, safePage, safeLimit);
  }

  async getBadgeDetail(badgeId: string): Promise<object> {
    const badge = await this.prisma.badge.findUnique({
      where: { id: badgeId },
      include: {
        _count: { select: { userBadges: true } },
        userBadges: {
          orderBy: [{ earnedAt: 'desc' }, { id: 'desc' }],
          take: 100,
          include: {
            user: {
              select: { id: true, userId: true, username: true, fullName: true, avatarUrl: true },
            },
          },
        },
      },
    });
    if (!badge) {
      throw new NotFoundException({ code: ErrorCodes.BADGE_NOT_FOUND, message: 'Badge not found' });
    }
    const b = badge as typeof badge & {
      _count: { userBadges: number };
      userBadges: Array<{ id: string; userId: string; earnedAt: Date; user: unknown }>;
    };
    const { userBadges, _count, ...rest } = b;
    return {
      ...rest,
      holderCount: _count.userBadges,
      awardedCount: _count.userBadges,
      holders: userBadges.map((ub) => ({
        id: ub.id,
        userId: ub.userId,
        awardedAt: ub.earnedAt,
        user: ub.user,
      })),
    };
  }

  async createBadge(adminId: string, dto: CreateBadgeDto, ipAddress: string): Promise<object> {
    let badge;
    try {
      badge = await this.prisma.badge.create({
        data: {
          name: dto.name,
          iconUrl: dto.iconUrl,
          description: dto.description,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: ErrorCodes.BADGE_NAME_TAKEN, message: 'Badge name is already in use' });
      }
      throw error;
    }

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Badge',
      targetId: badge.id,
      description: `Created badge "${dto.name}"`,
      ipAddress,
    });

    return badge;
  }

  async updateBadge(badgeId: string, dto: UpdateBadgeDto, adminId: string, ipAddress: string): Promise<object> {
    const badge = await this.prisma.badge.findUnique({ where: { id: badgeId } });
    if (!badge) {
      throw new NotFoundException({ code: ErrorCodes.BADGE_NOT_FOUND, message: 'Badge not found' });
    }

    let updated;
    try {
      updated = await this.prisma.badge.update({
        where: { id: badgeId },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.iconUrl !== undefined && { iconUrl: dto.iconUrl }),
          ...(dto.description !== undefined && { description: dto.description }),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: ErrorCodes.BADGE_NAME_TAKEN, message: 'Badge name is already in use' });
      }
      throw error;
    }

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Badge',
      targetId: badge.id,
      description: `Updated badge "${updated.name}"`,
      ipAddress,
    });

    return updated;
  }

  async deleteBadge(badgeId: string, adminId: string, ipAddress: string): Promise<{ message: string }> {
    const badgeName = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const badge = await tx.badge.findUnique({ where: { id: badgeId } });
      if (!badge) {
        throw new NotFoundException({ code: ErrorCodes.BADGE_NOT_FOUND, message: 'Badge not found' });
      }

      // The count and delete must share a serializable transaction. Otherwise an
      // award can be inserted after the count and be removed by the Badge relation's
      // onDelete: Cascade when the admin deletes the badge.
      const awardedCount = await tx.userBadge.count({ where: { badgeId } });
      if (awardedCount > 0) {
        throw new BadRequestException({
          code: ErrorCodes.BADGE_HAS_AWARDS,
          message: 'Badge cannot be deleted after it has been awarded. Revoke awards explicitly first.',
        });
      }

      await tx.badge.delete({ where: { id: badgeId } });
      return badge.name;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Badge',
      targetId: badgeId,
      description: `Deleted badge "${badgeName}"`,
      ipAddress,
    });

    return { message: 'Badge deleted successfully' };
  }

  async awardBadge(badgeId: string, userId: string, adminId: string, ipAddress: string): Promise<object> {
    const badge = await this.prisma.badge.findUnique({ where: { id: badgeId } });
    if (!badge) {
      throw new NotFoundException({ code: ErrorCodes.BADGE_NOT_FOUND, message: 'Badge not found' });
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    const existing = await this.prisma.userBadge.findUnique({
      where: { userId_badgeId: { userId, badgeId } },
    });
    if (existing) {
      throw new ConflictException({ code: ErrorCodes.BADGE_ALREADY_AWARDED, message: 'User already has this badge' });
    }

    let userBadge;
    try {
      // The database unique key is authoritative; the pre-check above is only
      // a friendly fast path and can race with another admin request.
      userBadge = await this.prisma.userBadge.create({
        data: { userId, badgeId },
        include: { badge: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: ErrorCodes.BADGE_ALREADY_AWARDED, message: 'User already has this badge' });
      }
      throw error;
    }

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.BADGE_ASSIGNED,
      targetType: 'UserBadge',
      targetId: userBadge.id,
      description: `Awarded badge "${badge.name}" to user ${userId}`,
      ipAddress,
    });

    this.notificationQueue.enqueue({
      userId,
      type: NotificationType.BADGE_AWARDED,
      title: 'Badge Earned!',
      body: `Congratulations! You have earned the "${badge.name}" badge.`,
      pushData: { type: 'BADGE_AWARDED', badgeId },
      actionUrl: '/badges',
    }).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));

    return userBadge;
  }

  async revokeBadge(badgeId: string, userId: string, adminId: string, ipAddress: string): Promise<{ message: string }> {
    const userBadge = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.userBadge.findUnique({
        where: { userId_badgeId: { userId, badgeId } },
        include: { badge: true },
      });
      if (!existing) {
        throw new NotFoundException({ code: ErrorCodes.USER_BADGE_NOT_FOUND, message: 'User does not have this badge' });
      }
      const deleted = await tx.userBadge.deleteMany({ where: { userId, badgeId } });
      if (deleted.count === 0) {
        throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Badge award changed concurrently — please retry' });
      }
      return existing;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.BADGE_REVOKED,
      targetType: 'UserBadge',
      targetId: userBadge.id,
      description: `Revoked badge "${userBadge.badge.name}" from user ${userId}`,
      ipAddress,
    });

    return { message: 'Badge revoked successfully' };
  }
}
