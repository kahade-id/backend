import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';
import { DataCleanupService } from '../services/data-cleanup.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { EMAIL_QUEUE } from '../../queue/processors/email.processor';
import { DeletionRequestStatus } from '@prisma/client';
import { AccountDeletionService } from '../../users/account-deletion.service';

/**
 * GAP-A (G075): uji purge worker & pengingat penghapusan akun.
 * - G056: status terbaru dicek ulang dalam transaksi tepat sebelum purge.
 * - G058/G059: pengingat H-7 & H-1 via in-app (+email bila ada).
 * - G073: kunci per-user mencegah dua worker memproses user yang sama.
 */
describe('DataCleanupService deletion purge & reminders (GAP-A G051–G075)', () => {
  let service: DataCleanupService;

  const mockPrisma: any = {
    accountDeletionRequest: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    accountDeletionStatusHistory: { create: jest.fn() },
    user: { findUnique: jest.fn(), update: jest.fn() },
    notification: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };
  const mockRedis: any = {
    setNx: jest.fn(),
    releaseLock: jest.fn().mockResolvedValue(undefined),
    setex: jest.fn().mockResolvedValue('OK'),
    get: jest.fn(),
  };
  const mockEmailQueue = { add: jest.fn().mockResolvedValue({}) };
  // SEC-001: re-check eligibilitas di dalam transaksi purge.
  const mockAccountDeletion = {
    getDeletionEligibility: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockPrisma));
    // Default: eligible — perilaku purge normal untuk test lama.
    mockAccountDeletion.getDeletionEligibility.mockResolvedValue({ eligible: true, blockers: [] });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataCleanupService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
        { provide: getQueueToken(EMAIL_QUEUE), useValue: mockEmailQueue },
        { provide: AccountDeletionService, useValue: mockAccountDeletion },
      ],
    }).compile();
    service = module.get<DataCleanupService>(DataCleanupService);
    // onModuleInit membuat hash bcrypt — panggil agar anonymizedPasswordHash ada.
    await service.onModuleInit();
  });

  describe('purgeDueDeletionRequests (G056/G073)', () => {
    const dueRequest = {
      id: 'req-1',
      userId: 'user-1',
      status: DeletionRequestStatus.REQUESTED,
      purgeAt: new Date(Date.now() - 1000),
    };

    it('mem-purge request yang jatuh tempo: PURGED + history + lock dilepas', async () => {
      mockPrisma.accountDeletionRequest.findMany.mockResolvedValue([dueRequest]);
      mockPrisma.accountDeletionRequest.findUnique.mockResolvedValue(dueRequest);
      mockRedis.setNx.mockResolvedValue(true);

      const purged = await (service as any).purgeDueDeletionRequests();

      expect(purged).toBe(1);
      expect(mockPrisma.accountDeletionRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { status: DeletionRequestStatus.PURGED, purgedAt: expect.any(Date) },
      });
      expect(mockPrisma.accountDeletionStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          requestId: 'req-1',
          fromStatus: DeletionRequestStatus.REQUESTED,
          toStatus: DeletionRequestStatus.PURGED,
          actorType: 'SYSTEM',
        }),
      });
      // Anonimkan PII user.
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: expect.objectContaining({ fullName: 'Deleted User' }),
      });
      expect(mockRedis.releaseLock).toHaveBeenCalled();
    });

    it('MELEWATI request yang sudah CANCELLED saat dibaca ulang (G056)', async () => {
      mockPrisma.accountDeletionRequest.findMany.mockResolvedValue([dueRequest]);
      // Pembatalan detik terakhir: status terbaru CANCELLED.
      mockPrisma.accountDeletionRequest.findUnique.mockResolvedValue({
        ...dueRequest,
        status: DeletionRequestStatus.CANCELLED,
      });
      mockRedis.setNx.mockResolvedValue(true);

      const purged = await (service as any).purgeDueDeletionRequests();

      expect(purged).toBe(0);
      expect(mockPrisma.accountDeletionRequest.update).not.toHaveBeenCalled();
      expect(mockPrisma.accountDeletionStatusHistory.create).not.toHaveBeenCalled();
    });

    it('MELEWATI request ON_HOLD (retensi hukum, G067)', async () => {
      mockPrisma.accountDeletionRequest.findMany.mockResolvedValue([dueRequest]);
      mockPrisma.accountDeletionRequest.findUnique.mockResolvedValue({
        ...dueRequest,
        status: DeletionRequestStatus.ON_HOLD,
      });
      mockRedis.setNx.mockResolvedValue(true);

      const purged = await (service as any).purgeDueDeletionRequests();
      expect(purged).toBe(0);
      expect(mockPrisma.accountDeletionRequest.update).not.toHaveBeenCalled();
    });

    it('tidak memproses dua kali bila lock dipegang worker lain (G073)', async () => {
      mockPrisma.accountDeletionRequest.findMany.mockResolvedValue([dueRequest]);
      mockRedis.setNx.mockResolvedValue(false); // lock gagal

      const purged = await (service as any).purgeDueDeletionRequests();

      expect(purged).toBe(0);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('SEC-001: memanggil getDeletionEligibility di dalam transaksi (tx dipakai)', async () => {
      mockPrisma.accountDeletionRequest.findMany.mockResolvedValue([dueRequest]);
      mockPrisma.accountDeletionRequest.findUnique.mockResolvedValue(dueRequest);
      mockRedis.setNx.mockResolvedValue(true);

      await (service as any).purgeDueDeletionRequests();

      expect(mockAccountDeletion.getDeletionEligibility).toHaveBeenCalledWith('user-1', mockPrisma);
    });

    it('SEC-001: request TIDAK eligible → ON_HOLD otomatis + legalHoldReason, user TIDAK dianonimkan', async () => {
      mockPrisma.accountDeletionRequest.findMany.mockResolvedValue([dueRequest]);
      mockPrisma.accountDeletionRequest.findUnique.mockResolvedValue(dueRequest);
      mockRedis.setNx.mockResolvedValue(true);
      mockAccountDeletion.getDeletionEligibility.mockResolvedValue({
        eligible: false,
        blockers: [{ code: 'ACTIVE_ORDERS_PRESENT', message: 'Anda memiliki 1 sengketa yang sedang berjalan.' }],
      });

      const purged = await (service as any).purgeDueDeletionRequests();

      expect(purged).toBe(0);
      // Request ditahan, bukan di-purge.
      expect(mockPrisma.accountDeletionRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: {
          status: DeletionRequestStatus.ON_HOLD,
          legalHoldReason: expect.stringContaining('sengketa'),
        },
      });
      // Riwayat REQUESTED → ON_HOLD tercatat.
      expect(mockPrisma.accountDeletionStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          requestId: 'req-1',
          fromStatus: DeletionRequestStatus.REQUESTED,
          toStatus: DeletionRequestStatus.ON_HOLD,
          actorType: 'SYSTEM',
        }),
      });
      // PII user TIDAK boleh dianonimkan saat ditahan.
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockRedis.releaseLock).toHaveBeenCalled();
    });
  });

  describe('processDeletionReminders (G058/G059)', () => {
    const req7d = {
      id: 'req-7d',
      userId: 'user-7d',
      referenceCode: 'KDEL-ABC123',
      purgeAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
    };

    it('mengirim pengingat H-7: in-app + flag, email bila ada alamat', async () => {
      mockPrisma.accountDeletionRequest.findMany
        .mockResolvedValueOnce([req7d]) // due7d
        .mockResolvedValueOnce([]); // due1d
      mockPrisma.accountDeletionRequest.findUnique.mockResolvedValue({
        status: DeletionRequestStatus.REQUESTED,
        reminder7dSent: false,
        reminder1dSent: false,
      });
      mockRedis.setNx.mockResolvedValue(true);
      mockPrisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });

      const { sent7d, sent1d } = await (service as any).processDeletionReminders();

      expect(sent7d).toBe(1);
      expect(sent1d).toBe(0);
      // G059: in-app notification selalu dibuat.
      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-7d',
          title: expect.stringContaining('7 hari'),
          refType: 'ACCOUNT_DELETION',
          refId: 'KDEL-ABC123',
        }),
      });
      expect(mockEmailQueue.add).toHaveBeenCalled();
      expect(mockPrisma.accountDeletionRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-7d' },
        data: { reminder7dSent: true },
      });
    });

    it('tidak mengirim dua kali bila flag sudah diset', async () => {
      mockPrisma.accountDeletionRequest.findMany
        .mockResolvedValueOnce([req7d])
        .mockResolvedValueOnce([]);
      mockPrisma.accountDeletionRequest.findUnique.mockResolvedValue({
        status: DeletionRequestStatus.REQUESTED,
        reminder7dSent: true, // sudah dikirim
        reminder1dSent: false,
      });
      mockRedis.setNx.mockResolvedValue(true);

      const { sent7d } = await (service as any).processDeletionReminders();
      expect(sent7d).toBe(0);
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });

    it('tidak mengirim bila request sudah CANCELLED', async () => {
      mockPrisma.accountDeletionRequest.findMany
        .mockResolvedValueOnce([req7d])
        .mockResolvedValueOnce([]);
      mockPrisma.accountDeletionRequest.findUnique.mockResolvedValue({
        status: DeletionRequestStatus.CANCELLED,
        reminder7dSent: false,
        reminder1dSent: false,
      });
      mockRedis.setNx.mockResolvedValue(true);

      const { sent7d } = await (service as any).processDeletionReminders();
      expect(sent7d).toBe(0);
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });
  });
});
