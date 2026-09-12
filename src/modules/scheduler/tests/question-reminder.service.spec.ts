jest.mock('../../../common/utils/cron-jitter.util', () => ({ cronJitter: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../common/utils/redis-health.util', () => ({ ensureRedisAvailable: jest.fn().mockResolvedValue(true) }));

import { Test, TestingModule } from '@nestjs/testing';
import { NotificationType } from '@prisma/client';
import { QuestionReminderService, UNANSWERED_REMINDER_HOURS } from '../services/question-reminder.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { getCategoryForType } from '../../notifications/notification-category.map';

const mockedEnsureRedis = ensureRedisAvailable as jest.Mock;

const mockPrisma: any = {
  profileQuestion: { findMany: jest.fn(), updateMany: jest.fn() },
};
const mockRedis = { setNx: jest.fn(), releaseLock: jest.fn() };
const mockQueue = { enqueue: jest.fn() };

function pendingQuestion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cquestion000000000000001',
    question: 'Berapa lama pengerjaannya?',
    upvoteCount: 0,
    receiverId: 'owner-1',
    receiver: { username: 'seller', fullName: 'Toko Seller' },
    ...overrides,
  };
}

describe('QuestionReminderService — pengingat pertanyaan belum dijawab 48 jam', () => {
  let service: QuestionReminderService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedEnsureRedis.mockResolvedValue(true);
    mockRedis.setNx.mockResolvedValue(true);
    mockRedis.releaseLock.mockResolvedValue(true);
    mockQueue.enqueue.mockResolvedValue(undefined);
    mockPrisma.profileQuestion.findMany.mockResolvedValue([]);
    mockPrisma.profileQuestion.updateMany.mockResolvedValue({ count: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuestionReminderService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: NotificationQueueService, useValue: mockQueue },
      ],
    }).compile();
    service = module.get<QuestionReminderService>(QuestionReminderService);
  });

  describe('guard rails', () => {
    it('skips the run when Redis is unreachable', async () => {
      mockedEnsureRedis.mockResolvedValue(false);
      await expect(service.sendUnansweredQuestionReminders()).resolves.toBeUndefined();
      expect(mockPrisma.profileQuestion.findMany).not.toHaveBeenCalled();
      expect(mockRedis.setNx).not.toHaveBeenCalled();
    });

    it('skips the run when another instance holds the cron lock', async () => {
      mockRedis.setNx.mockResolvedValue(false);
      await service.sendUnansweredQuestionReminders();
      expect(mockRedis.setNx).toHaveBeenCalledWith('cron_lock:unanswered_question_reminders', expect.any(String), 900);
      expect(mockPrisma.profileQuestion.findMany).not.toHaveBeenCalled();
      expect(mockRedis.releaseLock).not.toHaveBeenCalled();
    });

    it('releases the lock even when the query blows up', async () => {
      mockPrisma.profileQuestion.findMany.mockRejectedValue(new Error('db down'));
      await expect(service.sendUnansweredQuestionReminders()).resolves.toBeUndefined();
      expect(mockRedis.releaseLock).toHaveBeenCalledWith('cron_lock:unanswered_question_reminders', expect.any(String));
    });

    it('swallows a releaseLock failure so the cron never rejects', async () => {
      mockRedis.releaseLock.mockRejectedValue(new Error('redis gone'));
      await expect(service.sendUnansweredQuestionReminders()).resolves.toBeUndefined();
    });

    it('does nothing when there is no unanswered question', async () => {
      await service.sendUnansweredQuestionReminders();
      expect(mockQueue.enqueue).not.toHaveBeenCalled();
      expect(mockPrisma.profileQuestion.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('candidate selection', () => {
    it('selects only unanswered, unhidden, un-reminded questions older than 48h', async () => {
      await service.sendUnansweredQuestionReminders();
      const args = mockPrisma.profileQuestion.findMany.mock.calls[0][0];
      expect(args.where).toMatchObject({
        answeredAt: null,
        isHidden: false,
        reminderSentAt: null,
        receiver: { isActive: true, isBanned: false, deletedAt: null },
      });
      const cutoff = args.where.createdAt.lte as Date;
      const expected = Date.now() - UNANSWERED_REMINDER_HOURS * 60 * 60 * 1000;
      // Toleransi beberapa detik untuk durasi test itu sendiri.
      expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5000);
    });

    it('processes the longest-waiting questions first and caps the batch', async () => {
      await service.sendUnansweredQuestionReminders();
      const args = mockPrisma.profileQuestion.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
      expect(args.take).toBe(200);
    });

    it('never reminds a banned or deleted receiver', async () => {
      await service.sendUnansweredQuestionReminders();
      const receiverFilter = mockPrisma.profileQuestion.findMany.mock.calls[0][0].where.receiver;
      expect(receiverFilter.isActive).toBe(true);
      expect(receiverFilter.isBanned).toBe(false);
      expect(receiverFilter.deletedAt).toBeNull();
    });
  });

  describe('exactly-once delivery', () => {
    it('claims the row with a conditional updateMany before enqueueing', async () => {
      mockPrisma.profileQuestion.findMany.mockResolvedValue([pendingQuestion()]);
      await service.sendUnansweredQuestionReminders();

      expect(mockPrisma.profileQuestion.updateMany).toHaveBeenCalledTimes(1);
      const claim = mockPrisma.profileQuestion.updateMany.mock.calls[0][0];
      expect(claim.where.id).toBe('cquestion000000000000001');
      // Syarat `reminderSentAt: null` adalah kunci anti double-send: instance
      // kedua yang balapan mendapat count 0.
      expect(claim.where.reminderSentAt).toBeNull();
      expect(claim.data.reminderSentAt).toBeInstanceOf(Date);
      expect(mockPrisma.profileQuestion.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        mockQueue.enqueue.mock.invocationCallOrder[0],
      );
    });

    it('skips a question whose claim was lost to another instance', async () => {
      mockPrisma.profileQuestion.findMany.mockResolvedValue([pendingQuestion()]);
      mockPrisma.profileQuestion.updateMany.mockResolvedValue({ count: 0 });
      await service.sendUnansweredQuestionReminders();
      expect(mockQueue.enqueue).not.toHaveBeenCalled();
    });

    it('releases the claim when enqueueing fails so the next tick retries', async () => {
      mockPrisma.profileQuestion.findMany.mockResolvedValue([pendingQuestion()]);
      mockQueue.enqueue.mockRejectedValue(new Error('queue down'));
      await expect(service.sendUnansweredQuestionReminders()).resolves.toBeUndefined();
      expect(mockPrisma.profileQuestion.updateMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.profileQuestion.updateMany.mock.calls[1][0]).toEqual({
        where: { id: 'cquestion000000000000001' },
        data: { reminderSentAt: null },
      });
    });

    it('survives a failed claim rollback and keeps processing', async () => {
      mockPrisma.profileQuestion.findMany.mockResolvedValue([pendingQuestion()]);
      mockQueue.enqueue.mockRejectedValue(new Error('queue down'));
      mockPrisma.profileQuestion.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockRejectedValueOnce(new Error('db down'));
      await expect(service.sendUnansweredQuestionReminders()).resolves.toBeUndefined();
    });

    it('keeps going after one question fails', async () => {
      mockPrisma.profileQuestion.findMany.mockResolvedValue([
        pendingQuestion({ id: 'q1' }),
        pendingQuestion({ id: 'q2' }),
      ]);
      mockQueue.enqueue.mockRejectedValueOnce(new Error('queue down')).mockResolvedValueOnce(undefined);
      await service.sendUnansweredQuestionReminders();
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(2);
    });
  });

  describe('notification category', () => {
    it('routes the reminder into the INFORMASI tab', async () => {
      // Bukan transaksi dan bukan uang, jadi sengaja tidak didaftarkan di
      // TRANSAKSI_TYPES/KEUANGAN_TYPES: fallback INFORMASI sudah benar.
      expect(getCategoryForType(NotificationType.QUESTION_UNANSWERED_REMINDER)).toBe('INFORMASI');
    });
  });

  describe('notification payload', () => {
    it('enqueues QUESTION_UNANSWERED_REMINDER for the receiver', async () => {
      mockPrisma.profileQuestion.findMany.mockResolvedValue([pendingQuestion()]);
      await service.sendUnansweredQuestionReminders();
      const job = mockQueue.enqueue.mock.calls[0][0];
      expect(job).toMatchObject({
        userId: 'owner-1',
        type: NotificationType.QUESTION_UNANSWERED_REMINDER,
        title: 'Pertanyaan belum dijawab',
        actionUrl: '/questions/cquestion000000000000001',
        pushData: { questionId: 'cquestion000000000000001', reason: 'UNANSWERED_48H' },
      });
      expect(job.body).toContain('Berapa lama pengerjaannya?');
      expect(job.body).toContain(`${UNANSWERED_REMINDER_HOURS} jam`);
    });

    it('mentions how many people are waiting when the question has upvotes', async () => {
      mockPrisma.profileQuestion.findMany.mockResolvedValue([pendingQuestion({ upvoteCount: 4 })]);
      await service.sendUnansweredQuestionReminders();
      expect(mockQueue.enqueue.mock.calls[0][0].body).toContain('4 orang menunggu jawaban');
    });

    it('omits the upvote note for a question without upvotes', async () => {
      mockPrisma.profileQuestion.findMany.mockResolvedValue([pendingQuestion({ upvoteCount: 0 })]);
      await service.sendUnansweredQuestionReminders();
      expect(mockQueue.enqueue.mock.calls[0][0].body).not.toContain('orang menunggu jawaban');
    });

    it('escapes HTML in the question snippet', async () => {
      mockPrisma.profileQuestion.findMany.mockResolvedValue([
        pendingQuestion({ question: '<script>alert("x")</script> berapa lama?' }),
      ]);
      await service.sendUnansweredQuestionReminders();
      const body = mockQueue.enqueue.mock.calls[0][0].body as string;
      expect(body).not.toContain('<script>');
      expect(body).toContain('&lt;script&gt;');
    });

    it('clips a long question to a short snippet', async () => {
      mockPrisma.profileQuestion.findMany.mockResolvedValue([pendingQuestion({ question: 'a'.repeat(400) })]);
      await service.sendUnansweredQuestionReminders();
      const body = mockQueue.enqueue.mock.calls[0][0].body as string;
      expect(body).toContain('…');
      expect(body).not.toContain('a'.repeat(100));
    });

    it('collapses whitespace so the notification stays on one line', async () => {
      mockPrisma.profileQuestion.findMany.mockResolvedValue([
        pendingQuestion({ question: '  berapa   lama\npengerjaannya?  ' }),
      ]);
      await service.sendUnansweredQuestionReminders();
      expect(mockQueue.enqueue.mock.calls[0][0].body).toContain('"berapa lama pengerjaannya?"');
    });
  });
});
