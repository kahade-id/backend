import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ProfileQAService } from '../profile-qa.service';
import { PrismaService } from '../../../prisma/prisma.service';

const mockPrisma: any = {
  user: { findUnique: jest.fn() },
  blockList: { findFirst: jest.fn() },
  profileQuestion: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn(), count: jest.fn(), delete: jest.fn() },
  profileQuestionComment: { findUnique: jest.fn(), create: jest.fn(), findMany: jest.fn(), count: jest.fn(), delete: jest.fn() },
};

describe('ProfileQAService', () => {
  let service: ProfileQAService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.blockList.findFirst.mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProfileQAService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<ProfileQAService>(ProfileQAService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('askQuestion', () => {
    it('rejects too-short question', async () => {
      await expect(service.askQuestion('a', 'b', 'hi')).rejects.toThrow(BadRequestException);
    });

    it('rejects profanity', async () => {
      await expect(service.askQuestion('a', 'b', 'kamu anjing banget ya')).rejects.toThrow(BadRequestException);
    });

    it('rejects spam (repeated chars)', async () => {
      await expect(service.askQuestion('a', 'b', 'aaaaaaaaaaaaaa what up')).rejects.toThrow(BadRequestException);
    });

    it('rejects spam phrases', async () => {
      await expect(service.askQuestion('a', 'b', 'buy now please click here free money')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFound when receiver missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.askQuestion('a', 'bob', 'this is a question')).rejects.toThrow(NotFoundException);
    });

    it('rejects asking yourself', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'a', profileVisible: true, isActive: true, isBanned: false, deletedAt: null });
      await expect(service.askQuestion('a', 'me', 'this is a question')).rejects.toThrow(BadRequestException);
    });

    it('rejects when blocked', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'b', profileVisible: true, isActive: true, isBanned: false, deletedAt: null });
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'block1' });
      await expect(service.askQuestion('a', 'bob', 'this is a question')).rejects.toThrow(NotFoundException);
    });

    it('creates question when valid', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'b', profileVisible: true, isActive: true, isBanned: false, deletedAt: null });
      mockPrisma.profileQuestion.create.mockResolvedValue({ id: 'q1', question: 'this is a question', createdAt: new Date() });
      const res = await service.askQuestion('a', 'bob', 'this is a question');
      expect(res.id).toBe('q1');
    });
  });

  describe('answerQuestion', () => {
    it('rejects empty answer', async () => {
      await expect(service.answerQuestion('u1', 'q1', '')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFound when question missing', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue(null);
      await expect(service.answerQuestion('u1', 'q1', 'ok')).rejects.toThrow(NotFoundException);
    });

    it('throws Forbidden when not receiver', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue({ id: 'q1', receiverId: 'other' });
      await expect(service.answerQuestion('u1', 'q1', 'ok')).rejects.toThrow(ForbiddenException);
    });

    it('escapes HTML in answer', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue({ id: 'q1', receiverId: 'u1' });
      mockPrisma.profileQuestion.update.mockResolvedValue({ id: 'q1', answer: 'sanitized', answeredAt: new Date() });
      await service.answerQuestion('u1', 'q1', '<script>x</script>');
      const call = mockPrisma.profileQuestion.update.mock.calls[0][0];
      expect(call.data.answer).not.toContain('<script>');
    });
  });

  describe('addComment', () => {
    it('rejects on profanity', async () => {
      await expect(service.addComment('u1', 'q1', 'anjing!')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFound when question missing', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue(null);
      await expect(service.addComment('u1', 'q1', 'nice')).rejects.toThrow(NotFoundException);
    });

    it('throws Forbidden when private/hidden', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue({ id: 'q1', receiverId: 'r', isPublic: false, isHidden: false, answeredAt: new Date() });
      await expect(service.addComment('u1', 'q1', 'nice')).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequest for unanswered', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue({ id: 'q1', receiverId: 'r', isPublic: true, isHidden: false, answeredAt: null });
      await expect(service.addComment('u1', 'q1', 'nice')).rejects.toThrow(BadRequestException);
    });

    it('rejects nested reply', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue({ id: 'q1', receiverId: 'r', isPublic: true, isHidden: false, answeredAt: new Date() });
      mockPrisma.profileQuestionComment.findUnique.mockResolvedValue({ id: 'p1', questionId: 'q1', parentId: 'p0' });
      await expect(service.addComment('u1', 'q1', 'reply', 'p1')).rejects.toThrow(BadRequestException);
    });

    it('creates comment when valid', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue({ id: 'q1', receiverId: 'r', isPublic: true, isHidden: false, answeredAt: new Date() });
      mockPrisma.profileQuestionComment.create.mockResolvedValue({
        id: 'c1', content: 'nice', parentId: null,
        author: { username: 'a', fullName: null, avatarUrl: null },
        createdAt: new Date(),
      });
      const res = await service.addComment('u1', 'q1', 'nice');
      expect(res.id).toBe('c1');
    });
  });

  describe('getProfileQuestions', () => {
    it('rejects invalid pagination values safely', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'receiver-1', profileVisible: true, isActive: true, isBanned: false, deletedAt: null });
      mockPrisma.profileQuestion.findMany.mockResolvedValue([]);
      mockPrisma.profileQuestion.count.mockResolvedValue(0);
      const result = await service.getProfileQuestions('public-user', Number.NaN, Number.NaN);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('hides questions when receiver profile is private', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'receiver-1', profileVisible: false });
      await expect(service.getProfileQuestions('private-user', 1, 20)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.profileQuestion.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getComments', () => {
    it('rejects a public question whose receiver is inactive', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue({ id: 'q1', isPublic: true, isHidden: false, answeredAt: new Date(), receiver: { profileVisible: true, isActive: false, isBanned: false, deletedAt: null } });
      await expect(service.getComments('q1', 1, 10)).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFound when question missing', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue(null);
      await expect(service.getComments('q1', 1, 10)).rejects.toThrow(NotFoundException);
    });

    it('throws Forbidden when private', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue({ id: 'q1', isPublic: false, isHidden: false, answeredAt: new Date(), receiver: { profileVisible: true } });
      await expect(service.getComments('q1', 1, 10)).rejects.toThrow(ForbiddenException);
    });

    it('rejects comments for a private receiver profile', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue({ id: 'q1', isPublic: true, isHidden: false, answeredAt: new Date(), receiver: { profileVisible: false } });
      await expect(service.getComments('q1', 1, 10)).rejects.toThrow(ForbiddenException);
    });

    it('returns paginated comments', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue({ id: 'q1', isPublic: true, isHidden: false, answeredAt: new Date(), receiver: { profileVisible: true, isActive: true, isBanned: false, deletedAt: null } });
      mockPrisma.profileQuestionComment.findMany.mockResolvedValue([]);
      mockPrisma.profileQuestionComment.count.mockResolvedValue(0);
      const res = await service.getComments('q1', 1, 10);
      expect(res.total).toBe(0);
    });
  });

  describe('deleteComment', () => {
    it('throws NotFound when missing', async () => {
      mockPrisma.profileQuestionComment.findUnique.mockResolvedValue(null);
      await expect(service.deleteComment('u1', 'c1')).rejects.toThrow(NotFoundException);
    });

    it('throws Forbidden when neither author nor receiver', async () => {
      mockPrisma.profileQuestionComment.findUnique.mockResolvedValue({ authorId: 'x', question: { receiverId: 'y' } });
      await expect(service.deleteComment('u1', 'c1')).rejects.toThrow(ForbiddenException);
    });

    it('allows author to delete', async () => {
      mockPrisma.profileQuestionComment.findUnique.mockResolvedValue({ authorId: 'u1', question: { receiverId: 'y' } });
      const res = await service.deleteComment('u1', 'c1');
      expect(res.message).toContain('deleted');
    });

    it('allows receiver to delete', async () => {
      mockPrisma.profileQuestionComment.findUnique.mockResolvedValue({ authorId: 'x', question: { receiverId: 'u1' } });
      const res = await service.deleteComment('u1', 'c1');
      expect(res.message).toContain('deleted');
    });
  });

  describe('deleteQuestion', () => {
    it('throws Forbidden when not participant', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue({ receiverId: 'x', askerId: 'y' });
      await expect(service.deleteQuestion('u1', 'q1')).rejects.toThrow(ForbiddenException);
    });

    it('allows receiver or asker to delete', async () => {
      mockPrisma.profileQuestion.findUnique.mockResolvedValue({ receiverId: 'u1', askerId: 'y' });
      const res = await service.deleteQuestion('u1', 'q1');
      expect(res.message).toContain('deleted');
    });
  });
});
