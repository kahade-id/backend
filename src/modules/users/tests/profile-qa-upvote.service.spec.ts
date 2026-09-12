import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ContentHiddenReason } from '@prisma/client';
import { ProfileQAService } from '../profile-qa.service';
import { PrismaService } from '../../../prisma/prisma.service';
import * as ErrorCodes from '../../../common/constants/error-codes';

const ASKER_ID = 'asker-1';
const OWNER_ID = 'owner-1';
const VIEWER_ID = 'viewer-1';
const QUESTION_ID = 'cquestion000000000000001';
const COMMENT_ID = 'ccomment0000000000000001';

const mockPrisma: any = {
  user: { findUnique: jest.fn() },
  blockList: { findFirst: jest.fn() },
  profileQuestion: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  profileQuestionComment: { findUnique: jest.fn(), update: jest.fn() },
  profileQuestionUpvote: { findMany: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
  $transaction: jest.fn(),
};

function questionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: QUESTION_ID,
    askerId: ASKER_ID,
    receiverId: OWNER_ID,
    question: 'Berapa lama pengerjaannya?',
    answer: null,
    answeredAt: null,
    isPublic: true,
    isHidden: false,
    hiddenReason: null,
    hiddenAt: null,
    hiddenBy: null,
    upvoteCount: 3,
    reminderSentAt: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

function uniqueViolation() {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

describe('ProfileQAService (Section 4) — upvote, sort, moderasi beralasan', () => {
  let service: ProfileQAService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(mockPrisma) : Promise.all(arg as never[]),
    );
    mockPrisma.blockList.findFirst.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({
      id: OWNER_ID, profileVisible: true, isActive: true, isBanned: false, deletedAt: null,
    });
    mockPrisma.profileQuestion.findFirst.mockResolvedValue(questionRow());
    mockPrisma.profileQuestion.findUnique.mockResolvedValue(questionRow());
    mockPrisma.profileQuestion.findMany.mockResolvedValue([]);
    mockPrisma.profileQuestion.count.mockResolvedValue(0);
    mockPrisma.profileQuestion.update.mockImplementation(async (args: any) => ({ ...questionRow(), ...args.data }));
    mockPrisma.profileQuestion.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.profileQuestionUpvote.findMany.mockResolvedValue([]);
    mockPrisma.profileQuestionUpvote.create.mockResolvedValue({ id: 'up-1' });
    mockPrisma.profileQuestionUpvote.deleteMany.mockResolvedValue({ count: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [ProfileQAService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<ProfileQAService>(ProfileQAService);
  });

  // ------------------------------------------------------------------
  // Upvote
  // ------------------------------------------------------------------
  describe('upvoteQuestion', () => {
    it('creates the upvote and bumps the counter inside one transaction', async () => {
      mockPrisma.profileQuestion.update.mockResolvedValue({ upvoteCount: 4 });
      await expect(service.upvoteQuestion(VIEWER_ID, QUESTION_ID)).resolves.toEqual({ upvoted: true, upvoteCount: 4 });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.profileQuestionUpvote.create).toHaveBeenCalledWith({
        data: { userId: VIEWER_ID, questionId: QUESTION_ID },
      });
      expect(mockPrisma.profileQuestion.update).toHaveBeenCalledWith({
        where: { id: QUESTION_ID },
        data: { upvoteCount: { increment: 1 } },
        select: { upvoteCount: true },
      });
    });

    it('only allows upvoting a public, visible question of a healthy owner', async () => {
      await service.upvoteQuestion(VIEWER_ID, QUESTION_ID);
      expect(mockPrisma.profileQuestion.findFirst).toHaveBeenCalledWith({
        where: {
          id: QUESTION_ID,
          isPublic: true,
          isHidden: false,
          receiver: { isActive: true, isBanned: false, deletedAt: null, profileVisible: true },
        },
        select: { id: true, receiverId: true, upvoteCount: true },
      });
    });

    it('returns 404 for a hidden, private or unhealthy-owner question', async () => {
      // findFirst memfilter isPublic/isHidden/kesehatan owner di DB; mock
      // menirukannya dengan mengembalikan null.
      mockPrisma.profileQuestion.findFirst.mockResolvedValue(null);
      await expect(service.upvoteQuestion(VIEWER_ID, QUESTION_ID)).rejects.toMatchObject({
        response: { code: ErrorCodes.QUESTION_NOT_FOUND },
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.profileQuestionUpvote.create).not.toHaveBeenCalled();
    });

    it('rejects upvoting a question on your own profile', async () => {
      await expect(service.upvoteQuestion(OWNER_ID, QUESTION_ID)).rejects.toMatchObject({
        response: { code: ErrorCodes.CANNOT_ASK_SELF },
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects upvoting across a block relationship without leaking the question', async () => {
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'b1' });
      await expect(service.upvoteQuestion(VIEWER_ID, QUESTION_ID)).rejects.toThrow(NotFoundException);
      await expect(service.upvoteQuestion(VIEWER_ID, QUESTION_ID)).rejects.toMatchObject({
        response: { code: ErrorCodes.USER_NOT_FOUND },
      });
      expect(mockPrisma.blockList.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { blockerId: VIEWER_ID, blockedId: OWNER_ID },
              { blockerId: OWNER_ID, blockedId: VIEWER_ID },
            ],
          },
        }),
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('maps a unique-constraint race to 409 QUESTION_ALREADY_UPVOTED with the live count', async () => {
      mockPrisma.profileQuestionUpvote.create.mockRejectedValue(uniqueViolation());
      mockPrisma.profileQuestion.findUnique.mockResolvedValue({ upvoteCount: 7 });
      await expect(service.upvoteQuestion(VIEWER_ID, QUESTION_ID)).rejects.toMatchObject({
        response: { code: ErrorCodes.QUESTION_ALREADY_UPVOTED, upvoteCount: 7 },
      });
    });

    it('rethrows a non-unique database error untouched', async () => {
      const boom = new Error('db down');
      mockPrisma.profileQuestionUpvote.create.mockRejectedValue(boom);
      await expect(service.upvoteQuestion(VIEWER_ID, QUESTION_ID)).rejects.toBe(boom);
    });
  });

  describe('removeUpvote', () => {
    it('deletes the upvote and decrements with a non-negative guard', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue({ upvoteCount: 2 });
      await expect(service.removeUpvote(VIEWER_ID, QUESTION_ID)).resolves.toEqual({ upvoted: false, upvoteCount: 2 });
      expect(mockPrisma.profileQuestionUpvote.deleteMany).toHaveBeenCalledWith({
        where: { userId: VIEWER_ID, questionId: QUESTION_ID },
      });
      expect(mockPrisma.profileQuestion.updateMany).toHaveBeenCalledWith({
        where: { id: QUESTION_ID, upvoteCount: { gt: 0 } },
        data: { upvoteCount: { decrement: 1 } },
      });
    });

    it('returns 404 QUESTION_NOT_UPVOTED when there is nothing to remove', async () => {
      mockPrisma.profileQuestionUpvote.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.removeUpvote(VIEWER_ID, QUESTION_ID)).rejects.toMatchObject({
        response: { code: ErrorCodes.QUESTION_NOT_UPVOTED },
      });
      // Rollback transaksi: counter tidak boleh ikut berkurang.
      expect(mockPrisma.profileQuestion.updateMany).not.toHaveBeenCalled();
    });

    it('returns 404 for a question that is not publicly visible', async () => {
      mockPrisma.profileQuestion.findFirst.mockResolvedValue(null);
      await expect(service.removeUpvote(VIEWER_ID, QUESTION_ID)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.profileQuestionUpvote.deleteMany).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // Daftar + sort
  // ------------------------------------------------------------------
  describe('getProfileQuestions', () => {
    const answered = (id: string, upvoteCount: number) => ({
      id,
      question: `Q ${id}`,
      answer: 'A',
      answeredAt: new Date('2026-09-02T00:00:00.000Z'),
      asker: { username: 'asker', fullName: 'Asker', avatarUrl: null },
      comments: [],
      _count: { comments: 0 },
      upvoteCount,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    it('exposes upvoteCount and marks the viewer\'s own upvotes in one batched query', async () => {
      mockPrisma.profileQuestion.findMany.mockResolvedValue([answered('q1', 5), answered('q2', 1)]);
      mockPrisma.profileQuestionUpvote.findMany.mockResolvedValue([{ questionId: 'q2' }]);

      const result = await service.getProfileQuestions('owner', 1, 20, 'recent', VIEWER_ID);
      expect(result.questions.map(q => q.upvoteCount)).toEqual([5, 1]);
      expect(result.questions.map(q => q.isUpvotedByViewer)).toEqual([false, true]);
      expect(mockPrisma.profileQuestionUpvote.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.profileQuestionUpvote.findMany).toHaveBeenCalledWith({
        where: { userId: VIEWER_ID, questionId: { in: ['q1', 'q2'] } },
        select: { questionId: true },
      });
    });

    it('orders by answeredAt with an { id } tiebreak for the default recent sort', async () => {
      await service.getProfileQuestions('owner', 1, 20);
      expect(mockPrisma.profileQuestion.findMany.mock.calls[0][0].orderBy).toEqual([
        { answeredAt: 'desc' },
        { id: 'asc' },
      ]);
    });

    it('orders by upvoteCount for sort=top, keeping answeredAt and { id } as tiebreaks', async () => {
      const result = await service.getProfileQuestions('owner', 1, 20, 'top');
      expect(mockPrisma.profileQuestion.findMany.mock.calls[0][0].orderBy).toEqual([
        { upvoteCount: 'desc' },
        { answeredAt: 'desc' },
        { id: 'asc' },
      ]);
      expect(result.sort).toBe('top');
    });

    it('falls back to recent for an unknown sort value', async () => {
      const result = await service.getProfileQuestions('owner', 1, 20, 'trending' as never);
      expect(result.sort).toBe('recent');
      expect(mockPrisma.profileQuestion.findMany.mock.calls[0][0].orderBy).toEqual([
        { answeredAt: 'desc' },
        { id: 'asc' },
      ]);
    });

    it('rejects a blocked viewer with 403 USER_BLOCKED', async () => {
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'b1' });
      await expect(service.getProfileQuestions('owner', 1, 20, 'recent', VIEWER_ID)).rejects.toThrow(ForbiddenException);
      await expect(service.getProfileQuestions('owner', 1, 20, 'recent', VIEWER_ID)).rejects.toMatchObject({
        response: { code: ErrorCodes.USER_BLOCKED },
      });
      expect(mockPrisma.profileQuestion.findMany).not.toHaveBeenCalled();
    });

    it('skips the block check for an anonymous viewer and for the owner', async () => {
      await service.getProfileQuestions('owner', 1, 20);
      await service.getProfileQuestions('owner', 1, 20, 'recent', OWNER_ID);
      expect(mockPrisma.blockList.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('getMyQuestions', () => {
    it('exposes upvoteCount and supports sort=top for the inbox', async () => {
      mockPrisma.profileQuestion.findMany.mockResolvedValue([
        {
          id: 'q1', question: 'Q', answer: null, answeredAt: null, isPublic: true,
          asker: { username: 'a', fullName: 'A', avatarUrl: null },
          receiver: { username: 'o', fullName: 'O', avatarUrl: null },
          _count: { comments: 0 }, upvoteCount: 9, createdAt: new Date(),
        },
      ]);
      const result = await service.getMyQuestions(OWNER_ID, 'received', 1, 20, 'top');
      expect(result.sort).toBe('top');
      expect(result.questions[0]).toMatchObject({ upvoteCount: 9 });
      expect(mockPrisma.profileQuestion.findMany.mock.calls[0][0].orderBy).toEqual([
        { upvoteCount: 'desc' },
        { createdAt: 'desc' },
        { id: 'asc' },
      ]);
    });

    it('still rejects an invalid question type', async () => {
      await expect(service.getMyQuestions(OWNER_ID, 'other' as never, 1, 20)).rejects.toThrow(BadRequestException);
    });
  });

  // ------------------------------------------------------------------
  // Moderasi beralasan
  // ------------------------------------------------------------------
  describe('hideQuestion / unhideQuestion', () => {
    it('hides a question with a categorised reason', async () => {
      await service.hideQuestion(OWNER_ID, QUESTION_ID, ContentHiddenReason.HARASSMENT);
      expect(mockPrisma.profileQuestion.update).toHaveBeenCalledWith({
        where: { id: QUESTION_ID },
        data: {
          isHidden: true,
          hiddenReason: ContentHiddenReason.HARASSMENT,
          hiddenAt: expect.any(Date),
          hiddenBy: OWNER_ID,
        },
        select: { id: true, isHidden: true, hiddenReason: true, hiddenAt: true },
      });
    });

    it('unhides a question and clears every moderation field', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue(questionRow({ isHidden: true, hiddenReason: ContentHiddenReason.SPAM }));
      await service.unhideQuestion(OWNER_ID, QUESTION_ID);
      expect(mockPrisma.profileQuestion.update).toHaveBeenCalledWith({
        where: { id: QUESTION_ID },
        data: { isHidden: false, hiddenReason: null, hiddenAt: null, hiddenBy: null },
        select: { id: true, isHidden: true, hiddenReason: true, hiddenAt: true },
      });
    });

    it('refuses to hide without a reason', async () => {
      await expect(
        service.hideQuestion(OWNER_ID, QUESTION_ID, undefined as unknown as ContentHiddenReason),
      ).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_ERROR } });
      expect(mockPrisma.profileQuestion.update).not.toHaveBeenCalled();
    });

    it('only lets the profile owner moderate', async () => {
      await expect(service.hideQuestion(VIEWER_ID, QUESTION_ID, ContentHiddenReason.SPAM)).rejects.toMatchObject({
        response: { code: ErrorCodes.FORBIDDEN },
      });
      expect(mockPrisma.profileQuestion.update).not.toHaveBeenCalled();
    });

    it('rejects a no-op transition with 409', async () => {
      await expect(service.unhideQuestion(OWNER_ID, QUESTION_ID)).rejects.toThrow(ConflictException);
      mockPrisma.profileQuestion.findUnique.mockResolvedValue(questionRow({ isHidden: true, hiddenReason: ContentHiddenReason.OTHER }));
      await expect(service.hideQuestion(OWNER_ID, QUESTION_ID, ContentHiddenReason.OTHER)).rejects.toThrow(ConflictException);
    });

    it('returns 404 for an unknown question', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue(null);
      await expect(service.hideQuestion(OWNER_ID, QUESTION_ID, ContentHiddenReason.SPAM)).rejects.toThrow(NotFoundException);
    });
  });

  describe('hideComment / unhideComment', () => {
    beforeEach(() => {
      mockPrisma.profileQuestionComment.findUnique.mockResolvedValue({
        id: COMMENT_ID, isHidden: false, question: { receiverId: OWNER_ID },
      });
      mockPrisma.profileQuestionComment.update.mockImplementation(async (args: any) => ({ id: COMMENT_ID, ...args.data }));
    });

    it('hides a comment with a categorised reason', async () => {
      const result = (await service.hideComment(OWNER_ID, COMMENT_ID, ContentHiddenReason.INAPPROPRIATE)) as any;
      expect(result).toMatchObject({ isHidden: true, hiddenReason: ContentHiddenReason.INAPPROPRIATE });
      expect(mockPrisma.profileQuestionComment.update).toHaveBeenCalledWith({
        where: { id: COMMENT_ID },
        data: {
          isHidden: true,
          hiddenReason: ContentHiddenReason.INAPPROPRIATE,
          hiddenAt: expect.any(Date),
          hiddenBy: OWNER_ID,
        },
        select: { id: true, isHidden: true, hiddenReason: true, hiddenAt: true },
      });
    });

    it('unhides a comment and clears the moderation fields', async () => {
      mockPrisma.profileQuestionComment.findUnique.mockResolvedValue({
        id: COMMENT_ID, isHidden: true, question: { receiverId: OWNER_ID },
      });
      await service.unhideComment(OWNER_ID, COMMENT_ID);
      expect(mockPrisma.profileQuestionComment.update).toHaveBeenCalledWith({
        where: { id: COMMENT_ID },
        data: { isHidden: false, hiddenReason: null, hiddenAt: null, hiddenBy: null },
        select: { id: true, isHidden: true, hiddenReason: true, hiddenAt: true },
      });
    });

    it('refuses to hide without a reason', async () => {
      await expect(
        service.hideComment(OWNER_ID, COMMENT_ID, undefined as unknown as ContentHiddenReason),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.profileQuestionComment.update).not.toHaveBeenCalled();
    });

    it('only lets the profile owner moderate comments', async () => {
      await expect(service.hideComment(VIEWER_ID, COMMENT_ID, ContentHiddenReason.SPAM)).rejects.toMatchObject({
        response: { code: ErrorCodes.FORBIDDEN },
      });
    });

    it('returns 404 for an unknown comment', async () => {
      mockPrisma.profileQuestionComment.findUnique.mockResolvedValue(null);
      await expect(service.hideComment(OWNER_ID, COMMENT_ID, ContentHiddenReason.SPAM)).rejects.toThrow(NotFoundException);
    });
  });
});
