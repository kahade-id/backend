import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminRole, FeedbackAuditAction, FeedbackCloseReason, FeedbackStatus } from '@prisma/client';
import {
  AdminFeedbackService,
  maskContact,
} from '../admin-feedback.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { NotificationsService } from '../../../notifications/notifications.service';
import * as ErrorCodes from '../../../../common/constants/error-codes';

const mockPrisma = {
  feedback: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
    aggregate: jest.fn(),
    $queryRaw: jest.fn(),
  },
  feedbackAssignment: { create: jest.fn() },
  feedbackInternalNote: { create: jest.fn() },
  feedbackReply: { create: jest.fn() },
  feedbackAudit: { create: jest.fn() },
  feedbackSlaRule: { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn(), delete: jest.fn() },
  adminUser: { findFirst: jest.fn() },
  notification: { create: jest.fn() },
  emitNotificationCreated: jest.fn(),
};
const mockNotifications = { isInAppEnabled: jest.fn() };

function feedbackRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'clxfeedback00000000000001',
    category: 'Bug aplikasi',
    message: 'Aplikasi crash saat membuka etalase',
    rating: 2,
    platform: 'android',
    userId: 'usr-1',
    contact: '+6281234567890',
    contactConsent: true,
    status: FeedbackStatus.NEW,
    assigneeId: null,
    tags: [],
    impactLabel: null,
    appVersion: '1.2.3',
    slaDueAt: null,
    riskFlag: 'NONE',
    closedReason: null,
    closedAt: null,
    redactedAt: null,
    createdAt: new Date('2026-09-20T10:00:00.000Z'),
    ...overrides,
  };
}

describe('AdminFeedbackService', () => {
  let service: AdminFeedbackService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockNotifications.isInAppEnabled.mockResolvedValue(true);
    mockPrisma.notification.create.mockResolvedValue({ notifId: 'NTF-1' });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminFeedbackService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();
    service = module.get(AdminFeedbackService);
  });

  describe('maskContact', () => {
    it('me-masking nomor telepon gaya +62****1234', () => {
      expect(maskContact('+6281234567890')).toBe('+62****7890');
    });

    it('me-masking penuh untuk kontak pendek', () => {
      expect(maskContact('12345')).toBe('****');
    });
  });

  describe('listQueue (G155/G156/G173)', () => {
    it('tidak membocorkan contact di daftar antrean', async () => {
      mockPrisma.feedback.findMany.mockResolvedValue([
        { id: 'a1', category: 'Bug', message: 'x'.repeat(400), rating: 1, platform: 'android', userId: null, status: 'NEW', createdAt: new Date() },
      ]);
      const result = (await service.listQueue({})) as {
        data: Array<Record<string, unknown>>;
        nextCursor: string | null;
        hasMore: boolean;
      };
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).not.toHaveProperty('contact');
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it('search hanya menyentuh message & kategori dan tidak mengembalikan contact', async () => {
      mockPrisma.feedback.findMany.mockResolvedValue([]);
      await service.listQueue({ search: '  crash etalase  ' });
      const where = mockPrisma.feedback.findMany.mock.calls[0][0].where;
      const searchClause = (where.AND as Array<{ OR: unknown[] }>).find((c) => c.OR);
      expect(searchClause).toBeDefined();
      expect(JSON.stringify(searchClause!.OR)).toContain('message');
      expect(JSON.stringify(searchClause!.OR)).toContain('category');
      expect(JSON.stringify(searchClause!.OR)).not.toContain('contact');
      const select = mockPrisma.feedback.findMany.mock.calls[0][0].select;
      expect(select).not.toHaveProperty('contact');
    });

    it('menerapkan filter status, rating, platform, dan akun guest', async () => {
      mockPrisma.feedback.findMany.mockResolvedValue([]);
      await service.listQueue({
        status: FeedbackStatus.NEW,
        rating: 2,
        platform: 'android',
        account: 'guest',
      });
      const where = mockPrisma.feedback.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        status: FeedbackStatus.NEW,
        rating: 2,
        platform: 'android',
        userId: null,
      });
    });

    it('cursor invalid ditolak', async () => {
      await expect(service.listQueue({ cursor: 'bukan-cursor-valid!!!' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getDetail (G172)', () => {
    it('CUSTOMER_SUPPORT melihat contact ter-masking', async () => {
      mockPrisma.feedback.findUnique.mockResolvedValue({
        ...feedbackRow(),
        assignments: [],
        internalNotes: [{ id: 'n1', note: 'catatan internal' }],
        replies: [],
        audit: [],
      });
      const result = (await service.getDetail('clxfeedback00000000000001', AdminRole.CUSTOMER_SUPPORT)) as {
        data: Record<string, unknown>;
      };
      expect(result.data.contact).toBe('+62****7890');
      expect(result.data.contactMasked).toBe(true);
      // internal notes tetap terlihat kedua role
      expect(result.data.internalNotes).toHaveLength(1);
    });

    it('SUPER_ADMIN melihat contact penuh', async () => {
      mockPrisma.feedback.findUnique.mockResolvedValue({
        ...feedbackRow(),
        assignments: [],
        internalNotes: [],
        replies: [],
        audit: [],
      });
      const result = (await service.getDetail('clxfeedback00000000000001', AdminRole.SUPER_ADMIN)) as {
        data: Record<string, unknown>;
      };
      expect(result.data.contact).toBe('+6281234567890');
      expect(result.data.contactMasked).toBe(false);
    });

    it('guest tanpa contact → null untuk kedua role', async () => {
      mockPrisma.feedback.findUnique.mockResolvedValue({
        ...feedbackRow({ userId: null, contact: null }),
        assignments: [],
        internalNotes: [],
        replies: [],
        audit: [],
      });
      const result = (await service.getDetail('clxfeedback00000000000001', AdminRole.CUSTOMER_SUPPORT)) as {
        data: Record<string, unknown>;
      };
      expect(result.data.contact).toBeNull();
    });

    it('feedback tidak ada → 404', async () => {
      mockPrisma.feedback.findUnique.mockResolvedValue(null);
      await expect(
        service.getDetail('clxfeedback00000000000001', AdminRole.SUPER_ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateStatus (G153/G171)', () => {
    it('menolak transisi invalid NEW → ACTIONED', async () => {
      mockPrisma.feedback.findUnique.mockResolvedValue(feedbackRow({ status: FeedbackStatus.NEW }));
      await expect(
        service.updateStatus('clxfeedback00000000000001', 'admin-1', {
          status: FeedbackStatus.ACTIONED,
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.FEEDBACK_INVALID_STATUS_TRANSITION }),
      });
      expect(mockPrisma.feedback.update).not.toHaveBeenCalled();
    });

    it('menolak CLOSED tanpa reason code', async () => {
      mockPrisma.feedback.findUnique.mockResolvedValue(feedbackRow({ status: FeedbackStatus.NEW }));
      await expect(
        service.updateStatus('clxfeedback00000000000001', 'admin-1', {
          status: FeedbackStatus.CLOSED,
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.FEEDBACK_CLOSE_REASON_REQUIRED }),
      });
    });

    it('mencatat audit STATUS_CHANGED pada transisi valid', async () => {
      mockPrisma.feedback.findUnique.mockResolvedValue(feedbackRow({ status: FeedbackStatus.NEW }));
      mockPrisma.feedback.update.mockResolvedValue(
        feedbackRow({ status: FeedbackStatus.IN_REVIEW, userId: 'usr-1', contactConsent: false }),
      );
      await service.updateStatus('clxfeedback00000000000001', 'admin-1', {
        status: FeedbackStatus.IN_REVIEW,
      });
      expect(mockPrisma.feedbackAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: FeedbackAuditAction.STATUS_CHANGED,
            adminId: 'admin-1',
            detail: expect.objectContaining({ from: 'NEW', to: 'IN_REVIEW' }),
          }),
        }),
      );
    });

    it('REOPEN CLOSED → IN_REVIEW tercatat sebagai REOPENED', async () => {
      mockPrisma.feedback.findUnique.mockResolvedValue(
        feedbackRow({ status: FeedbackStatus.CLOSED, closedReason: FeedbackCloseReason.SPAM }),
      );
      mockPrisma.feedback.update.mockResolvedValue(
        feedbackRow({ status: FeedbackStatus.IN_REVIEW, userId: 'usr-1', contactConsent: false }),
      );
      await service.updateStatus('clxfeedback00000000000001', 'admin-1', {
        status: FeedbackStatus.IN_REVIEW,
      });
      expect(mockPrisma.feedbackAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: FeedbackAuditAction.REOPENED }),
        }),
      );
    });

    it('CLOSED dengan reason mengirim notifikasi selesai bila user & consent', async () => {
      mockPrisma.feedback.findUnique.mockResolvedValue(
        feedbackRow({ status: FeedbackStatus.IN_REVIEW }),
      );
      mockPrisma.feedback.update.mockResolvedValue(
        feedbackRow({
          status: FeedbackStatus.CLOSED,
          closedReason: FeedbackCloseReason.RESOLVED,
          userId: 'usr-1',
          contactConsent: true,
        }),
      );
      await service.updateStatus('clxfeedback00000000000001', 'admin-1', {
        status: FeedbackStatus.CLOSED,
        reason: FeedbackCloseReason.RESOLVED,
      });
      expect(mockPrisma.notification.create).toHaveBeenCalled();
      expect(mockPrisma.emitNotificationCreated).toHaveBeenCalled();
    });
  });

  describe('assign (G154)', () => {
    it('mencatat assignment + audit ASSIGNED', async () => {
      mockPrisma.feedback.findUnique.mockResolvedValue(feedbackRow());
      mockPrisma.adminUser.findFirst.mockResolvedValue({ id: 'adm-2' });
      mockPrisma.feedbackAssignment.create.mockResolvedValue({ id: 'asg-1' });
      mockPrisma.feedback.update.mockResolvedValue({});

      const result = (await service.assign('clxfeedback00000000000001', 'admin-1', {
        adminId: 'adm-2',
        note: 'tolong follow up',
      })) as { data: Record<string, unknown> };

      expect(result.data.assigneeId).toBe('adm-2');
      expect(mockPrisma.feedbackAssignment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ feedbackId: 'clxfeedback00000000000001', adminId: 'adm-2' }),
        }),
      );
      expect(mockPrisma.feedbackAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: FeedbackAuditAction.ASSIGNED }),
        }),
      );
    });

    it('menolak admin tujuan yang tidak ada', async () => {
      mockPrisma.feedback.findUnique.mockResolvedValue(feedbackRow());
      mockPrisma.adminUser.findFirst.mockResolvedValue(null);
      await expect(
        service.assign('clxfeedback00000000000001', 'admin-1', { adminId: 'adm-x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.feedbackAssignment.create).not.toHaveBeenCalled();
    });
  });

  describe('contactSender (G161)', () => {
    it('consent=false memblokir contact', async () => {
      mockPrisma.feedback.findUnique.mockResolvedValue(
        feedbackRow({ contactConsent: false, contact: '+6281234567890' }),
      );
      await expect(
        service.contactSender('clxfeedback00000000000001', 'admin-1', AdminRole.SUPER_ADMIN),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.FEEDBACK_CONTACT_CONSENT_REQUIRED }),
      });
      expect(mockPrisma.feedbackAudit.create).not.toHaveBeenCalled();
    });

    it('contact kosong memblokir contact', async () => {
      mockPrisma.feedback.findUnique.mockResolvedValue(
        feedbackRow({ contactConsent: true, contact: null }),
      );
      await expect(
        service.contactSender('clxfeedback00000000000001', 'admin-1', AdminRole.SUPER_ADMIN),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.FEEDBACK_CONTACT_NOT_AVAILABLE }),
      });
    });

    it('consent=true + contact ada → audit CONTACTED tanpa contact penuh', async () => {
      mockPrisma.feedback.findUnique.mockResolvedValue(feedbackRow());
      const result = (await service.contactSender(
        'clxfeedback00000000000001',
        'admin-1',
        AdminRole.CUSTOMER_SUPPORT,
      )) as { data: Record<string, unknown> };
      expect(result.data.contacted).toBe(true);
      expect(result.data.contact).toBe('+62****7890');
      const auditCall = mockPrisma.feedbackAudit.create.mock.calls[0][0];
      expect(auditCall.data.action).toBe(FeedbackAuditAction.CONTACTED);
      expect(JSON.stringify(auditCall.data.detail)).not.toContain('+6281234567890');
      expect(JSON.stringify(auditCall.data.detail)).toContain('+62****7890');
    });
  });

  describe('reply (G162/G163/G164)', () => {
    it('menyimpan reply + audit REPLY_SENT + notifikasi bila consent', async () => {
      mockPrisma.feedback.findUnique.mockResolvedValue(feedbackRow());
      mockPrisma.feedbackReply.create.mockResolvedValue({
        id: 'rpl-1',
        createdAt: new Date(),
      });
      const result = (await service.reply('clxfeedback00000000000001', 'admin-1', {
        body: 'Terima kasih, sudah kami teruskan ke tim.',
      })) as { data: Record<string, unknown> };
      expect(result.data.notified).toBe(true);
      expect(mockPrisma.feedbackReply.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ adminId: 'admin-1' }),
        }),
      );
      expect(mockPrisma.feedbackAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: FeedbackAuditAction.REPLY_SENT }),
        }),
      );
      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'usr-1', refType: 'FEEDBACK' }),
        }),
      );
    });

    it('tidak mengirim notifikasi untuk guest atau tanpa consent', async () => {
      mockPrisma.feedback.findUnique.mockResolvedValue(
        feedbackRow({ userId: null, contactConsent: false }),
      );
      mockPrisma.feedbackReply.create.mockResolvedValue({ id: 'rpl-1', createdAt: new Date() });
      const result = (await service.reply('clxfeedback00000000000001', 'admin-1', {
        body: 'ok',
      })) as { data: Record<string, unknown> };
      expect(result.data.notified).toBe(false);
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });
  });

  describe('escalate (G169)', () => {
    it('FRAUD_RISK menaikkan flag + audit ESCALATED & RISK_FLAGGED', async () => {
      mockPrisma.feedback.findUnique.mockResolvedValue(feedbackRow());
      mockPrisma.feedback.update.mockResolvedValue(
        feedbackRow({ riskFlag: 'FRAUD_RISK' }),
      );
      mockPrisma.feedback.count.mockResolvedValue(0);
      const result = (await service.escalate('clxfeedback00000000000001', 'admin-1', {
        risk: 'FRAUD_RISK' as never,
        note: 'indikasi penipuan',
      })) as { data: Record<string, unknown> };
      expect(result.data.riskFlag).toBe('FRAUD_RISK');
      const actions = mockPrisma.feedbackAudit.create.mock.calls.map(
        (c: Array<{ data: { action: string } }>) => c[0].data.action,
      );
      expect(actions).toContain(FeedbackAuditAction.ESCALATED);
      expect(actions).toContain(FeedbackAuditAction.RISK_FLAGGED);
    });
  });

  describe('findDuplicates (G160)', () => {
    it('mengembalikan skor kemiripan tanpa menolak otomatis', async () => {
      const base = feedbackRow({ message: 'aplikasi crash saat membuka etalase produk baru' });
      mockPrisma.feedback.findUnique.mockResolvedValue(base);
      mockPrisma.feedback.findMany.mockResolvedValue([
        {
          id: 'clxfeedback00000000000002',
          message: 'aplikasi crash saat membuka etalase produk',
          status: 'NEW',
          createdAt: new Date('2026-09-19T10:00:00.000Z'),
        },
        {
          id: 'clxfeedback00000000000003',
          message: 'saya suka warna aplikasinya sangat bagus sekali',
          status: 'NEW',
          createdAt: new Date('2026-09-18T10:00:00.000Z'),
        },
      ]);
      const result = (await service.findDuplicates('clxfeedback00000000000001')) as {
        data: { candidates: Array<{ id: string; score: number }> };
      };
      expect(result.data.candidates.length).toBeGreaterThan(0);
      expect(result.data.candidates[0].id).toBe('clxfeedback00000000000002');
      expect(result.data.candidates[0].score).toBeGreaterThan(0.5);
      // feedback tetap NEW — tidak ada penolakan otomatis
      expect(mockPrisma.feedback.update).not.toHaveBeenCalled();
    });
  });

  describe('redactExpiredGuestContacts (G165)', () => {
    it('meredaksi kontak guest berumur > 90 hari', async () => {
      mockPrisma.feedback.updateMany.mockResolvedValue({ count: 3 });
      const result = await service.redactExpiredGuestContacts();
      expect(result).toEqual({ redacted: 3 });
      const args = mockPrisma.feedback.updateMany.mock.calls[0][0];
      expect(args.where.userId).toBeNull();
      expect(args.where.contact).toEqual({ not: null });
      expect(args.where.redactedAt).toBeNull();
      expect(args.where.createdAt.lt.getTime()).toBeLessThan(
        Date.now() - 89 * 24 * 60 * 60 * 1000,
      );
      expect(args.data).toMatchObject({ contact: '[redacted]' });
      expect(args.data.redactedAt).toBeInstanceOf(Date);
    });
  });

  describe('exportAggregates (G166)', () => {
    it('tidak menyertakan kolom kontak/isi', async () => {
      mockPrisma.feedback.groupBy
        .mockResolvedValueOnce([{ category: 'Bug', _count: { _all: 2 } }])
        .mockResolvedValueOnce([{ status: 'NEW', _count: { _all: 2 } }])
        .mockResolvedValueOnce([{ rating: 5, _count: { _all: 2 } }])
        .mockResolvedValueOnce([{ platform: 'android', _count: { _all: 2 } }]);
      const result = (await service.exportAggregates('json')) as { data: Record<string, unknown> };
      const serialized = JSON.stringify(result.data);
      expect(serialized).not.toContain('contact');
      expect(serialized).not.toContain('message');
      expect(result.data.byCategory).toEqual([{ category: 'Bug', count: 2 }]);
    });
  });
});
