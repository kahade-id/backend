import { Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException, Logger } from '@nestjs/common';
import { Rating, NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CreateRatingDto } from './dto/create-rating.dto';
import { UpdateRatingDto } from './dto/update-rating.dto';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';
import { generateNotifId } from '../../common/utils/id-generator.util';
import { getCategoryForType } from '../notifications/notification-category.map';
import * as ErrorCodes from '../../common/constants/error-codes';
import { Decimal } from '@prisma/client/runtime/library';
import { RATING_WINDOW_DAYS, RATING_EDIT_WINDOW_DAYS } from '../../common/constants/app.constants';

@Injectable()
export class RatingsService {
  private readonly logger = new Logger(RatingsService.name);
  private readonly RATING_WINDOW_DAYS = RATING_WINDOW_DAYS;
  private readonly EDIT_WINDOW_DAYS = RATING_EDIT_WINDOW_DAYS;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  async createRating(userId: string, dto: CreateRatingDto): Promise<Rating> {
    // T1 (audit 2026-09-26): jangan izinkan rating untuk order yang di-soft-delete.
    const order = await this.prisma.order.findFirst({
      where: { orderId: dto.orderId, deletedAt: null },
      include: {
        dispute: {
          select: {
            status: true,
            decision: { select: { id: true } },
            mutualProposals: { where: { status: 'ACCEPTED' }, select: { id: true }, take: 1 },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    }

    if (order.status !== 'COMPLETED') {
      throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order must be completed to rate' });
    }

    // An ADMIN completion is rateable only when the linked dispute has reached a
    // terminal resolution path. Do not infer this from free-text history.reason:
    // mutual resolution uses a different reason, and arbitrary admin text may
    // otherwise spoof the old "Dispute resolved:" prefix.
    const adminCompletion = await this.prisma.orderStatusHistory.findFirst({
      where: { orderId: order.id, toStatus: 'COMPLETED', changedByType: 'ADMIN' },
      select: { id: true },
    });
    const disputeResolvedByResolution = order.dispute?.status === 'RESOLVED'
      && Boolean(order.dispute.decision || order.dispute.mutualProposals.length > 0);
    const adminForceCompleted = Boolean(adminCompletion) && !disputeResolvedByResolution;

    if (adminForceCompleted) {
      throw new BadRequestException({ code: ErrorCodes.RATING_BLOCKED_FORCE_COMPLETED, message: 'Rating is not allowed on admin-force-completed orders' });
    }

    const isBuyer = order.buyerId === userId;
    const isSeller = order.sellerId === userId;

    if (!isBuyer && !isSeller) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'You are not a participant of this order' });
    }

    const completedAt = order.completedAt;
    if (!completedAt) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order completion timestamp is required to rate' });
    }
    const windowEnd = new Date(completedAt.getTime() + this.RATING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    if (new Date() > windowEnd) {
      throw new BadRequestException({ code: ErrorCodes.RATING_WINDOW_CLOSED, message: `Rating window has closed (${this.RATING_WINDOW_DAYS} days after completion)` });
    }

    const existingRating = await this.prisma.rating.findUnique({
      where: { orderId_giverId: { orderId: order.id, giverId: userId } },
    });

    if (existingRating) {
      throw new BadRequestException({ code: ErrorCodes.ALREADY_RATED, message: 'You have already rated this order' });
    }

    const receiverId = isBuyer ? order.sellerId : order.buyerId;
    const giverRole = isBuyer ? 'BUYER' : 'SELLER';
    const normalizedComment = dto.comment?.trim() || null;

    // a race where a concurrent rating slips between create and aggregate,
    // resulting in a stale averageRating on the receiver's profile.
    let rating: Rating;
    try {
      rating = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${receiverId} FOR UPDATE`;

        const result = await tx.rating.create({
          data: {
            orderId: order.id,
            giverId: userId,
            receiverId,
            stars: dto.stars,
          comment: normalizedComment,
            giverRole,
          },
        });

        await this.updateReceiverStatsInTx(tx, receiverId);

        return result;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (err: unknown) {
      // The preflight check above is helpful for the common path, but cannot
      // arbitrate concurrent double-submits. The database unique constraint is
      // authoritative; expose the same stable domain response in both cases.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException({ code: ErrorCodes.ALREADY_RATED, message: 'You have already rated this order' });
      }
      throw err;
    }

    const giver = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true, username: true } });
    const giverName = giver?.fullName || giver?.username || 'User';
    try {
      await this.prisma.notification.create({
        data: {
          notifId: generateNotifId(), userId: receiverId,
          type: NotificationType.RATING_NEW, category: getCategoryForType(NotificationType.RATING_NEW),
          title: 'New Rating',
          body: `${giverName} gave you a ${dto.stars}-star rating.${dto.comment ? ` "${dto.comment.slice(0, 60)}"` : ''}`,
          isRead: false,
        },
      });
      this.prisma.emitNotificationCreated({ userId: receiverId, title: 'New Rating', body: `${giverName} gave a ${dto.stars}-star rating`, data: { type: 'RATING_NEW' } });
    } catch (notificationError: unknown) {
      this.logger.warn(`Rating notification failed after rating ${rating.id} was committed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`);
    }

    return rating;
  }

  async getMyRatings(userId: string, page: number, limit: number): Promise<{ given: PaginatedResponse<Record<string, unknown>>; received: PaginatedResponse<Record<string, unknown>> & { averageRating: number; ratingCount: number } }> {
    const safePage = Math.max(1, Math.trunc(Number(page) || 1));
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 20)));
    const skip = (safePage - 1) * safeLimit;

    /*
     * C-12: honour `RatingReply.isHidden`.
     *
     * The column exists (`schema.prisma`, alongside `hiddenAt`/`hiddenBy`) and mirrors
     * `Rating.isHidden`, which every read path already filters (`:140`, `:150`,
     * `users.service.ts:989`, `admin-ratings.service.ts:166`). The reply include did not,
     * so a moderated reply stayed visible to both parties.
     *
     * `where` inside a to-one `include` yields `null` when it does not match, which
     * `normalizeRating` below already handles — it maps a falsy `reply` to `replies: []`,
     * the same shape as a rating that was never replied to. Mobile reads
     * `(item.replies || []).length` (`components/ratings/RatingCard.tsx:37`), so a filtered
     * reply renders exactly like an absent one with no client change.
     */
    const replyInclude = {
      reply: {
        where: { isHidden: false },
        select: { id: true, content: true, createdAt: true, replierId: true },
      },
    };

    const [given, givenCount] = await Promise.all([
      this.prisma.rating.findMany({
        where: { giverId: userId, isHidden: false },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // R2-L: stable page ordering
        skip,
        take: safeLimit,
        include: {
          order: { select: { orderId: true, title: true } },
          receiver: { select: { userId: true, fullName: true, username: true, avatarUrl: true } },
          ...replyInclude,
        },
      }),
      this.prisma.rating.count({ where: { giverId: userId, isHidden: false } }),
    ]);

    const [received, receivedCount, receivedAggregate] = await Promise.all([
      this.prisma.rating.findMany({
        where: { receiverId: userId, isHidden: false },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // R2-L: stable page ordering
        skip,
        take: safeLimit,
        include: {
          order: { select: { orderId: true, title: true } },
          giver: { select: { userId: true, fullName: true, username: true, avatarUrl: true } },
          ...replyInclude,
        },
      }),
      this.prisma.rating.count({ where: { receiverId: userId, isHidden: false } }),
      this.prisma.rating.aggregate({ where: { receiverId: userId, isHidden: false }, _avg: { stars: true }, _count: { stars: true } }),
    ]);

    const normalizeRating = (r: typeof given[number] | typeof received[number]) => {
      const { reply, ...rest } = r;
      return {
        ...rest,
        replies: reply ? [{ ...reply, userId: reply.replierId }] : [],
      };
    };

    return {
      given: createPaginatedResponse(given.map(normalizeRating), givenCount, safePage, safeLimit),
      received: { ...createPaginatedResponse(received.map(normalizeRating), receivedCount, safePage, safeLimit), averageRating: Number(receivedAggregate._avg.stars ?? 0), ratingCount: receivedAggregate._count.stars },
    };
  }

  async updateRating(userId: string, ratingId: string, dto: UpdateRatingDto): Promise<Rating> {
    if (dto.stars === undefined && dto.comment === undefined) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Provide stars or a comment to update a rating' });
    }
    const rating = await this.prisma.rating.findUnique({
      where: { id: ratingId },
    });

    if (!rating) {
      throw new NotFoundException({ code: ErrorCodes.RATING_NOT_FOUND, message: 'Rating not found' });
    }

    if (rating.giverId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_RATING_GIVER, message: 'You can only edit your own ratings' });
    }

    if (rating.isHidden) {
      throw new NotFoundException({ code: ErrorCodes.RATING_NOT_FOUND, message: 'Rating not found' });
    }

    const editWindowEnd = new Date(rating.createdAt.getTime() + this.EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    if (new Date() > editWindowEnd) {
      throw new BadRequestException({ code: ErrorCodes.RATING_WINDOW_CLOSED, message: `Edit window has closed (${this.EDIT_WINDOW_DAYS} days after rating)` });
    }

    // Without this, a concurrent createRating() or second updateRating() can
    // interleave between the update and the aggregate, producing a stale average.
    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (dto.stars !== undefined) {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${rating.receiverId} FOR UPDATE`;
      }
      const guarded = await tx.rating.updateMany({
        where: { id: ratingId, giverId: userId, isHidden: false, createdAt: { lte: editWindowEnd } },
        data: {
          ...(dto.stars !== undefined && { stars: dto.stars }),
          ...(dto.comment !== undefined && { comment: dto.comment.trim() || null }),
        },
      });
      if (guarded.count === 0) {
        throw new ConflictException({ code: ErrorCodes.INVALID_STATUS, message: 'Rating was moderated or its edit window closed; reload and try again' });
      }
      const result = await tx.rating.findUniqueOrThrow({ where: { id: ratingId } });
      if (dto.stars !== undefined) await this.updateReceiverStatsInTx(tx, rating.receiverId);
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return updated;
  }

  private async updateReceiverStatsInTx(tx: Prisma.TransactionClient, receiverId: string): Promise<void> {
    const stats = await tx.rating.aggregate({
      where: { receiverId, isHidden: false },
      _avg: { stars: true },
      _count: { stars: true },
    });

    await tx.user.update({
      where: { id: receiverId },
      data: {
        averageRating: new Decimal(stats._avg.stars ?? 0),
        totalRatingCount: stats._count.stars,
      },
    });
  }

  async deleteRating(userId: string, ratingId: string): Promise<{ deleted: boolean }> {
    const rating = await this.prisma.rating.findUnique({ where: { id: ratingId } });
    if (!rating) throw new NotFoundException({ code: ErrorCodes.RATING_NOT_FOUND, message: 'Rating not found' });
    if (rating.giverId !== userId) throw new ForbiddenException({ code: ErrorCodes.NOT_RATING_GIVER, message: 'Not owner' });
    // S2 (audit 2026-09-26): dulu hard-coded 7 hari — pakai konstanta agar tidak drift
    // dari RATING_EDIT_WINDOW_DAYS.
    const deleteWindow = new Date(rating.createdAt.getTime() + this.EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    if (new Date() > deleteWindow) {
      throw new BadRequestException({ code: ErrorCodes.RATING_WINDOW_CLOSED, message: `Delete window closed (${this.EDIT_WINDOW_DAYS} days)` });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${rating.receiverId} FOR UPDATE`;
      await tx.rating.delete({ where: { id: ratingId } });
      await this.updateReceiverStatsInTx(tx, rating.receiverId);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { deleted: true };
  }

  async toggleHelpful(userId: string, ratingId: string): Promise<{ helpful: boolean; helpfulCount: number }> {
    const rating = await this.prisma.rating.findUnique({ where: { id: ratingId } });
    if (!rating || rating.isHidden) throw new NotFoundException({ code: ErrorCodes.RATING_NOT_FOUND, message: 'Rating not found' });
    if (rating.giverId === userId) throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Cannot mark own rating as helpful' });

    /*
     * K1 (audit 2026-09-26): implementasi sebelumnya tidak pernah persist — ia mencoba
     * model `prisma.ratingHelpful` yang tidak ada di schema, lalu jatuh ke fallback yang
     * langsung `return { helpful: true, helpfulCount: 1 }` tanpa menyimpan apa pun.
     * Endpoint ini dipakai aplikasi (app/ratings.tsx), jadi "tandai berguna" adalah no-op
     * yang berbohong.
     *
     * Belum ada tabel join di schema (perlu migration — direkomendasikan sebagai fix
     * permanen), jadi vote disimpan di Redis: satu SET pemilih per rating + satu counter.
     * Toggle atomik via Lua agar dua request bersamaan tidak menggandakan hitungan.
     * Catatan: hitungan ini best-effort — hilang jika Redis di-flush.
     */
    const prefix = this.redis.getPrefix();
    const votersKey = `${prefix}rating_helpful:voters:${ratingId}`;
    const countKey = `${prefix}rating_helpful:count:${ratingId}`;
    const script = `
      if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
        redis.call('SREM', KEYS[1], ARGV[1])
        local n = redis.call('DECR', KEYS[2])
        if n < 0 then redis.call('SET', KEYS[2], 0); n = 0 end
        return {0, n}
      else
        redis.call('SADD', KEYS[1], ARGV[1])
        local n = redis.call('INCR', KEYS[2])
        return {1, n}
      end
    `;
    try {
      const res = await this.redis.getClient().eval(script, 2, votersKey, countKey, userId) as [number, number];
      return { helpful: res[0] === 1, helpfulCount: Number(res[1]) };
    } catch (err) {
      this.logger.warn(`toggleHelpful Redis failed for rating ${ratingId}: ${err instanceof Error ? err.message : String(err)}`);
      throw new BadRequestException({ code: ErrorCodes.SERVICE_UNAVAILABLE, message: 'Helpful vote is temporarily unavailable, please retry' });
    }
  }
}
