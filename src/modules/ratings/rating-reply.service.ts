import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { generateNotifId } from '../../common/utils/id-generator.util';
import { getCategoryForType } from '../notifications/notification-category.map';
import * as ErrorCodes from '../../common/constants/error-codes';

export interface RatingReplyResponse {
  id: string;
  content: string;
  createdAt?: Date;
  updatedAt?: Date;
  userId: string;
  replierId: string;
}

@Injectable()
export class RatingReplyService {
  private readonly logger = new Logger(RatingReplyService.name);

  constructor(private prisma: PrismaService) {}

  async createReply(userId: string, ratingId: string, content: string): Promise<RatingReplyResponse> {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Reply content cannot be blank' });
    }
    const rating = await this.prisma.rating.findUnique({
      where: { id: ratingId },
      include: { reply: true },
    });

    if (!rating || rating.isHidden) throw new NotFoundException({ code: ErrorCodes.RATING_NOT_FOUND, message: 'Rating not found' });
    if (rating.receiverId !== userId) throw new ForbiddenException({ code: ErrorCodes.NOT_RATING_RECEIVER, message: 'Only the rating receiver can reply' });
    if (rating.reply) throw new BadRequestException({ code: ErrorCodes.REPLY_ALREADY_EXISTS, message: 'Reply already exists for this rating' });

    // C-17: the `rating.reply` check above is a separate read, so two concurrent POSTs to
    // `/ratings/:id/reply` both pass it (the throttle is 5/60s, which permits a double-tap).
    // `RatingReply.ratingId` is `@unique` (`schema.prisma`), so the loser hit P2002 and
    // surfaced as an opaque 500 instead of the REPLY_ALREADY_EXISTS the sequential path
    // returns. Mapping it here makes the DB the arbiter and keeps both orderings on the same
    // contract, matching how `referral.service.ts:129` handles its own unique collision.
    let reply;
    try {
      reply = await this.prisma.ratingReply.create({
        data: {
          ratingId,
          replierId: userId,
          content: normalizedContent,
        },
      });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException({
          code: ErrorCodes.REPLY_ALREADY_EXISTS,
          message: 'Reply already exists for this rating',
        });
      }
      throw err;
    }

    this.sendReplyNotification(userId, rating.giverId, normalizedContent).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));

    return {
      id: reply.id,
      content: reply.content,
      createdAt: reply.createdAt,
      userId: reply.replierId,
      replierId: reply.replierId,
    };
  }

  private readonly REPLY_EDIT_WINDOW_DAYS = 7;

  async updateReply(userId: string, replyId: string, content: string): Promise<RatingReplyResponse> {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Reply content cannot be blank' });
    }
    const reply = await this.prisma.ratingReply.findUnique({ where: { id: replyId }, include: { rating: { select: { isHidden: true } } } });
    if (!reply || reply.rating?.isHidden) throw new NotFoundException({ code: ErrorCodes.RATING_NOT_FOUND, message: 'Reply not found' });
    if (reply.replierId !== userId) throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not your reply' });

    const editDeadline = new Date(reply.createdAt.getTime() + this.REPLY_EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    if (new Date() > editDeadline) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Reply can only be edited within ${this.REPLY_EDIT_WINDOW_DAYS} days of posting` });
    }

    const result = await this.prisma.ratingReply.updateMany({
      where: { id: replyId, replierId: userId, isHidden: false, createdAt: { lte: editDeadline } },
      data: { content: normalizedContent },
    });
    if (result.count === 0) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Reply was moderated or its edit window closed; reload and try again' });
    }
    const updated = await this.prisma.ratingReply.findUniqueOrThrow({ where: { id: replyId } });
    return {
      id: updated.id,
      content: updated.content,
      updatedAt: updated.updatedAt,
      userId: updated.replierId,
      replierId: updated.replierId,
    };
  }

  async deleteReply(userId: string, replyId: string): Promise<{ message: string }> {
    const reply = await this.prisma.ratingReply.findUnique({ where: { id: replyId }, include: { rating: { select: { isHidden: true } } } });
    if (!reply || reply.rating?.isHidden) throw new NotFoundException({ code: ErrorCodes.RATING_NOT_FOUND, message: 'Reply not found' });
    if (reply.replierId !== userId) throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not your reply' });

    const deleteDeadline = new Date(reply.createdAt.getTime() + this.REPLY_EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    if (new Date() > deleteDeadline) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Reply can only be deleted within ${this.REPLY_EDIT_WINDOW_DAYS} days of posting` });
    }

    const result = await this.prisma.ratingReply.deleteMany({
      where: { id: replyId, replierId: userId, isHidden: false, createdAt: { lte: deleteDeadline } },
    });
    if (result.count === 0) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Reply was moderated, already deleted, or its delete window closed; reload and try again' });
    }
    return { message: 'Reply deleted' };
  }

  private async sendReplyNotification(replierId: string, giverId: string, content: string): Promise<void> {
    const replier = await this.prisma.user.findUnique({ where: { id: replierId }, select: { fullName: true, username: true } });
    const replierName = replier?.fullName || replier?.username || 'User';
    await this.prisma.notification.create({
      data: {
        notifId: generateNotifId(),
        userId: giverId,
        type: NotificationType.RATING_NEW,
        category: getCategoryForType(NotificationType.RATING_NEW),
        title: 'New Reply to Your Rating',
        body: `${replierName} replied to your rating: "${content.slice(0, 60)}"`,
        isRead: false,
      },
    });
    this.prisma.emitNotificationCreated({
      userId: giverId,
      title: 'New Reply to Your Rating',
      body: `${replierName} replied to your rating`,
      data: { type: 'RATING_NEW' },
    });
  }
}
