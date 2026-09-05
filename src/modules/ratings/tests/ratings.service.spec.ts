import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RatingsService } from '../ratings.service';
import { PrismaService } from '../../../prisma/prisma.service';

const mockPrisma: any = {
  order: { findFirst: jest.fn() },
  orderStatusHistory: { findFirst: jest.fn() },
  rating: {
    findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), findMany: jest.fn(), count: jest.fn(),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), aggregate: jest.fn(),
  },
  user: { findUnique: jest.fn(), update: jest.fn() },
  notification: { create: jest.fn() },
  $transaction: jest.fn(),
  $queryRaw: jest.fn().mockResolvedValue([]),
  emitNotificationCreated: jest.fn(),
};

describe('RatingsService', () => {
  let service: RatingsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    mockPrisma.rating.aggregate.mockResolvedValue({ _avg: { stars: 4 }, _count: { stars: 1 } });
    mockPrisma.rating.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.rating.findUniqueOrThrow.mockResolvedValue({ id: 'r1', stars: 4, comment: 'ok' });
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.notification.create.mockResolvedValue({});
    mockPrisma.user.findUnique.mockResolvedValue({ fullName: 'Alice', username: 'alice' });
    const module: TestingModule = await Test.createTestingModule({
      providers: [RatingsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<RatingsService>(RatingsService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('createRating', () => {
    it('throws NotFoundException when order missing', async () => {
      mockPrisma.order.findFirst.mockResolvedValue(null);
      await expect(service.createRating('u1', { orderId: 'o1', stars: 5 } as any)).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when order not COMPLETED', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({ id: 'oid', status: 'PENDING' });
      await expect(service.createRating('u1', { orderId: 'o1', stars: 5 } as any)).rejects.toThrow(BadRequestException);
    });

    it('throws when admin force-completed', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({ id: 'oid', status: 'COMPLETED', buyerId: 'u1', sellerId: 'u2', completedAt: new Date() });
      mockPrisma.orderStatusHistory.findFirst.mockResolvedValue({ id: 'h1' });
      await expect(service.createRating('u1', { orderId: 'o1', stars: 5 } as any)).rejects.toThrow(BadRequestException);
    });

    it('throws ForbiddenException when not participant', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({ id: 'oid', status: 'COMPLETED', buyerId: 'x', sellerId: 'y', completedAt: new Date() });
      mockPrisma.orderStatusHistory.findFirst.mockResolvedValue(null);
      await expect(service.createRating('u1', { orderId: 'o1', stars: 5 } as any)).rejects.toThrow(ForbiddenException);
    });

    it('throws when rating window closed', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({
        id: 'oid', status: 'COMPLETED', buyerId: 'u1', sellerId: 'u2',
        completedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
      });
      mockPrisma.orderStatusHistory.findFirst.mockResolvedValue(null);
      await expect(service.createRating('u1', { orderId: 'o1', stars: 5 } as any)).rejects.toThrow(BadRequestException);
    });

    it('requires a completion timestamp before opening the rating window', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({ id: 'oid', status: 'COMPLETED', buyerId: 'u1', sellerId: 'u2', completedAt: null });
      mockPrisma.orderStatusHistory.findFirst.mockResolvedValue(null);

      await expect(service.createRating('u1', { orderId: 'o1', stars: 5 } as any)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'INVALID_ORDER_STATUS' }),
      });
      expect(mockPrisma.rating.create).not.toHaveBeenCalled();
    });

    it('throws when already rated', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({ id: 'oid', status: 'COMPLETED', buyerId: 'u1', sellerId: 'u2', completedAt: new Date() });
      mockPrisma.orderStatusHistory.findFirst.mockResolvedValue(null);
      mockPrisma.rating.findUnique.mockResolvedValue({ id: 'r0' });
      await expect(service.createRating('u1', { orderId: 'o1', stars: 5 } as any)).rejects.toThrow(BadRequestException);
    });

    it('creates rating and updates receiver stats', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({ id: 'oid', status: 'COMPLETED', buyerId: 'u1', sellerId: 'u2', completedAt: new Date() });
      mockPrisma.orderStatusHistory.findFirst.mockResolvedValue(null);
      mockPrisma.rating.findUnique.mockResolvedValue(null);
      mockPrisma.rating.create.mockResolvedValue({ id: 'r1', stars: 5 });
      const res = await service.createRating('u1', { orderId: 'o1', stars: 5, comment: 'great' } as any);
      expect(res.id).toBe('r1');
      expect(mockPrisma.user.update).toHaveBeenCalled();
    });

    it('normalizes a whitespace-only optional comment to null', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({ id: 'oid', status: 'COMPLETED', buyerId: 'u1', sellerId: 'u2', completedAt: new Date() });
      mockPrisma.orderStatusHistory.findFirst.mockResolvedValue(null);
      mockPrisma.rating.findUnique.mockResolvedValue(null);
      mockPrisma.rating.create.mockResolvedValue({ id: 'r1', stars: 5 });

      await service.createRating('u1', { orderId: 'o1', stars: 5, comment: '   ' } as any);
      expect(mockPrisma.rating.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ comment: null }) }));
    });

    it('maps a concurrent unique constraint to ALREADY_RATED instead of leaking a database error', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({ id: 'oid', status: 'COMPLETED', buyerId: 'u1', sellerId: 'u2', completedAt: new Date() });
      mockPrisma.orderStatusHistory.findFirst.mockResolvedValue(null);
      mockPrisma.rating.findUnique.mockResolvedValue(null);
      mockPrisma.rating.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.22.0' }),
      );

      await expect(service.createRating('u1', { orderId: 'o1', stars: 5 } as any)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ALREADY_RATED' }),
      });
    });

    it('does not fail a durable rating when notification persistence fails', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({ id: 'oid', status: 'COMPLETED', buyerId: 'u1', sellerId: 'u2', completedAt: new Date() });
      mockPrisma.orderStatusHistory.findFirst.mockResolvedValue(null);
      mockPrisma.rating.findUnique.mockResolvedValue(null);
      mockPrisma.rating.create.mockResolvedValue({ id: 'r-notif', stars: 5 });
      mockPrisma.notification.create.mockRejectedValue(new Error('notification database unavailable'));
      await expect(service.createRating('u1', { orderId: 'o1', stars: 5 } as any)).resolves.toMatchObject({ id: 'r-notif' });
    });
  });

  describe('updateRating', () => {
    it('rejects an empty update payload', async () => {
      await expect(service.updateRating('u1', 'r1', {} as any)).rejects.toThrow(BadRequestException);
      expect(mockPrisma.rating.findUnique).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when missing', async () => {
      mockPrisma.rating.findUnique.mockResolvedValue(null);
      await expect(service.updateRating('u1', 'r1', { stars: 4 } as any)).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when not giver', async () => {
      mockPrisma.rating.findUnique.mockResolvedValue({ id: 'r1', giverId: 'other', createdAt: new Date(), receiverId: 'u2' });
      await expect(service.updateRating('u1', 'r1', { stars: 4 } as any)).rejects.toThrow(ForbiddenException);
    });

    it('does not allow a moderated hidden rating to be edited', async () => {
      mockPrisma.rating.findUnique.mockResolvedValue({ id: 'r1', giverId: 'u1', receiverId: 'u2', createdAt: new Date(), isHidden: true });

      await expect(service.updateRating('u1', 'r1', { stars: 4 } as any)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.rating.update).not.toHaveBeenCalled();
    });

    it('throws after edit window expires', async () => {
      mockPrisma.rating.findUnique.mockResolvedValue({
        id: 'r1', giverId: 'u1', receiverId: 'u2',
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      });
      await expect(service.updateRating('u1', 'r1', { stars: 4 } as any)).rejects.toThrow(BadRequestException);
    });

    it('updates within window', async () => {
      mockPrisma.rating.findUnique.mockResolvedValue({ id: 'r1', giverId: 'u1', receiverId: 'u2', createdAt: new Date() });
      mockPrisma.rating.update.mockResolvedValue({ id: 'r1', stars: 4, comment: 'ok' });
      const res = await service.updateRating('u1', 'r1', { stars: 4, comment: 'ok' } as any);
      expect(res.id).toBe('r1');
    });
  });

  describe('getMyRatings', () => {
    it('returns paginated given/received with normalized replies', async () => {
      mockPrisma.rating.findMany.mockResolvedValue([
        { id: 'r1', reply: { id: 'rep1', content: 'thx', createdAt: new Date(), replierId: 'u2' } },
      ]);
      mockPrisma.rating.count.mockResolvedValue(1);
      const res = await service.getMyRatings('u1', 1, 10);
      expect(res.given.data[0].replies).toHaveLength(1);
    });

    /*
     * C-12 regression: `RatingReply.isHidden` existed in the schema (with `hiddenAt`/`hiddenBy`,
     * mirroring `Rating.isHidden`) but no read path filtered it, so a moderated reply stayed
     * visible to both parties. Every `Rating.isHidden` read already filters — `:140`, `:150`,
     * `users.service.ts:989`, `admin-ratings.service.ts:166` — the reply include was the outlier.
     */
    it('filters hidden replies out of the include (C-12)', async () => {
      mockPrisma.rating.findMany.mockResolvedValue([]);
      mockPrisma.rating.count.mockResolvedValue(0);

      await service.getMyRatings('u1', 1, 10);

      for (const call of mockPrisma.rating.findMany.mock.calls) {
        expect(call[0].include.reply.where).toEqual({ isHidden: false });
      }
      expect(mockPrisma.rating.findMany).toHaveBeenCalledTimes(2);
    });

    it('normalizes a filtered-out reply to an empty array, like an unreplied rating (C-12)', async () => {
      // Prisma returns `null` for a to-one include whose `where` does not match. The client
      // reads `(item.replies || []).length` (`components/ratings/RatingCard.tsx:37`), so the
      // hidden case must be shaped identically to "never replied".
      mockPrisma.rating.findMany.mockResolvedValue([{ id: 'r1', reply: null }]);
      mockPrisma.rating.count.mockResolvedValue(1);

      const res = await service.getMyRatings('u1', 1, 10);

      expect(res.given.data[0].replies).toEqual([]);
      expect(res.given.data[0]).not.toHaveProperty('reply');
    });

    it('still keeps the isHidden filter on received ratings themselves', async () => {
      mockPrisma.rating.findMany.mockResolvedValue([]);
      mockPrisma.rating.count.mockResolvedValue(0);

      await service.getMyRatings('u1', 1, 10);

      const receivedCall = mockPrisma.rating.findMany.mock.calls[1][0];
      expect(receivedCall.where).toEqual({ receiverId: 'u1', isHidden: false });
    });

    it('also keeps moderated hidden ratings out of the given list', async () => {
      mockPrisma.rating.findMany.mockResolvedValue([]);
      mockPrisma.rating.count.mockResolvedValue(0);

      await service.getMyRatings('u1', 1, 10);

      const givenCall = mockPrisma.rating.findMany.mock.calls[0][0];
      expect(givenCall.where).toEqual({ giverId: 'u1', isHidden: false });
      expect(mockPrisma.rating.count.mock.calls[0][0]).toEqual({ where: { giverId: 'u1', isHidden: false } });
    });

    it('clamps invalid page and limit values before querying Prisma', async () => {
      mockPrisma.rating.findMany.mockResolvedValue([]);
      mockPrisma.rating.count.mockResolvedValue(0);
      await service.getMyRatings('u1', -4, 0);
      expect(mockPrisma.rating.findMany.mock.calls[0][0]).toMatchObject({ skip: 0, take: 20 });
      expect(mockPrisma.rating.findMany.mock.calls[1][0]).toMatchObject({ skip: 0, take: 20 });
    });
  });
});
