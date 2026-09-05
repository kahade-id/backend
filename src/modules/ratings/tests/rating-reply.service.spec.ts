import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RatingReplyService } from '../rating-reply.service';
import { PrismaService } from '../../../prisma/prisma.service';
import * as ErrorCodes from '../../../common/constants/error-codes';

const mockPrisma = {
  rating: { findUnique: jest.fn() },
  ratingReply: { create: jest.fn(), findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  notification: { create: jest.fn().mockResolvedValue({}) },
  user: { findUnique: jest.fn().mockResolvedValue({ fullName: 'Bob', username: 'bob' }) },
  emitNotificationCreated: jest.fn(),
};

describe('RatingReplyService', () => {
  let service: RatingReplyService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({ fullName: 'Bob', username: 'bob' });
    mockPrisma.notification.create.mockResolvedValue({});
    mockPrisma.ratingReply.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.ratingReply.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.ratingReply.findUniqueOrThrow.mockResolvedValue({ id: 'rep1', content: 'edited', replierId: 'u1', updatedAt: new Date() });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RatingReplyService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<RatingReplyService>(RatingReplyService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('createReply', () => {
    it('rejects whitespace-only content before reading the rating', async () => {
      await expect(service.createReply('u1', 'r1', '   ')).rejects.toThrow(BadRequestException);
      expect(mockPrisma.rating.findUnique).not.toHaveBeenCalled();
    });

    it('creates reply when receiver replies and no existing reply', async () => {
      mockPrisma.rating.findUnique.mockResolvedValue({ id: 'r1', receiverId: 'u1', giverId: 'u2', reply: null });
      mockPrisma.ratingReply.create.mockResolvedValue({ id: 'rep1', content: 'thanks', replierId: 'u1', createdAt: new Date() });
      const result = await service.createReply('u1', 'r1', 'thanks');
      expect(result.id).toBe('rep1');
    });

    it('throws NotFoundException when rating missing', async () => {
      mockPrisma.rating.findUnique.mockResolvedValue(null);
      await expect(service.createReply('u1', 'r1', 'x')).rejects.toThrow(NotFoundException);
    });

    it('does not allow a reply on a hidden rating', async () => {
      mockPrisma.rating.findUnique.mockResolvedValue({ id: 'r1', receiverId: 'u1', giverId: 'u2', isHidden: true, reply: null });
      await expect(service.createReply('u1', 'r1', 'x')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.ratingReply.create).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when not receiver', async () => {
      mockPrisma.rating.findUnique.mockResolvedValue({ id: 'r1', receiverId: 'other', giverId: 'u2', reply: null });
      await expect(service.createReply('u1', 'r1', 'x')).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when reply already exists', async () => {
      mockPrisma.rating.findUnique.mockResolvedValue({ id: 'r1', receiverId: 'u1', giverId: 'u2', reply: { id: 'old' } });
      await expect(service.createReply('u1', 'r1', 'x')).rejects.toThrow(BadRequestException);
    });

    /*
     * C-17: the `rating.reply` guard above is a separate read from the create, so two concurrent
     * POSTs to `/ratings/:id/reply` both see `reply: null` and both reach the insert. Because
     * `RatingReply.ratingId` is `@unique` (`schema.prisma`), the loser's insert raises P2002 —
     * which, unmapped, left the client with an opaque 500 while the *sequential* second request
     * got a clean REPLY_ALREADY_EXISTS. Same user action, two different contracts depending on
     * timing. The throttle is 5/60s, so a double-tap is well within what the route permits.
     */
    it('maps a P2002 on the concurrent insert to REPLY_ALREADY_EXISTS, not a 500', async () => {
      // `reply: null` — this request WON the read, exactly as the racing request did.
      mockPrisma.rating.findUnique.mockResolvedValue({ id: 'r1', receiverId: 'u1', giverId: 'u2', reply: null });
      mockPrisma.ratingReply.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`ratingId`)', {
          code: 'P2002',
          clientVersion: '5.22.0',
        }),
      );

      await expect(service.createReply('u1', 'r1', 'thanks')).rejects.toMatchObject({
        response: { code: ErrorCodes.REPLY_ALREADY_EXISTS },
      });
      await expect(service.createReply('u1', 'r1', 'thanks')).rejects.toThrow(BadRequestException);
    });

    it('does not swallow non-P2002 database errors', async () => {
      mockPrisma.rating.findUnique.mockResolvedValue({ id: 'r1', receiverId: 'u1', giverId: 'u2', reply: null });
      mockPrisma.ratingReply.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Value too long for column', {
          code: 'P2000',
          clientVersion: '5.22.0',
        }),
      );

      // Only the unique collision has a domain meaning; anything else must keep propagating.
      await expect(service.createReply('u1', 'r1', 'thanks')).rejects.toMatchObject({ code: 'P2000' });
    });

    it('never notifies the rating giver when the insert lost the race', async () => {
      mockPrisma.rating.findUnique.mockResolvedValue({ id: 'r1', receiverId: 'u1', giverId: 'u2', reply: null });
      mockPrisma.ratingReply.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.22.0' }),
      );

      await expect(service.createReply('u1', 'r1', 'thanks')).rejects.toThrow(BadRequestException);

      // The winner's create already fired its own notification; a second one would double-notify.
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
      expect(mockPrisma.emitNotificationCreated).not.toHaveBeenCalled();
    });
  });

  describe('updateReply', () => {
    it('rejects whitespace-only content before reading the reply', async () => {
      await expect(service.updateReply('u1', 'rep1', '   ')).rejects.toThrow(BadRequestException);
      expect(mockPrisma.ratingReply.findUnique).not.toHaveBeenCalled();
    });

    it('updates reply within 7-day window', async () => {
      mockPrisma.ratingReply.findUnique
        .mockResolvedValueOnce({ id: 'rep1', replierId: 'u1', createdAt: new Date(), isHidden: false })
        .mockResolvedValueOnce({ id: 'rep1', content: 'edited', replierId: 'u1', updatedAt: new Date() });
      mockPrisma.ratingReply.update.mockResolvedValue({ id: 'rep1', content: 'edited', replierId: 'u1', updatedAt: new Date() });
      const result = await service.updateReply('u1', 'rep1', 'edited');
      expect(result.content).toBe('edited');
    });

    it('throws NotFoundException when reply missing', async () => {
      mockPrisma.ratingReply.findUnique.mockResolvedValue(null);
      await expect(service.updateReply('u1', 'rep1', 'x')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when not author', async () => {
      mockPrisma.ratingReply.findUnique.mockResolvedValue({ id: 'rep1', replierId: 'other', createdAt: new Date() });
      await expect(service.updateReply('u1', 'rep1', 'x')).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException after edit window expires', async () => {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      mockPrisma.ratingReply.findUnique.mockResolvedValue({ id: 'rep1', replierId: 'u1', createdAt: old });
      await expect(service.updateReply('u1', 'rep1', 'x')).rejects.toThrow(BadRequestException);
    });
  });

  describe('deleteReply', () => {
    it('deletes reply within window', async () => {
      mockPrisma.ratingReply.findUnique.mockResolvedValue({ id: 'rep1', replierId: 'u1', createdAt: new Date() });
      mockPrisma.ratingReply.delete.mockResolvedValue({});
      const result = await service.deleteReply('u1', 'rep1');
      expect(result.message).toBe('Reply deleted');
    });

    it('throws ForbiddenException when not author', async () => {
      mockPrisma.ratingReply.findUnique.mockResolvedValue({ id: 'rep1', replierId: 'other', createdAt: new Date() });
      await expect(service.deleteReply('u1', 'rep1')).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException after delete window expires', async () => {
      const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      mockPrisma.ratingReply.findUnique.mockResolvedValue({ id: 'rep1', replierId: 'u1', createdAt: old });
      await expect(service.deleteReply('u1', 'rep1')).rejects.toThrow(BadRequestException);
    });
  });
});
