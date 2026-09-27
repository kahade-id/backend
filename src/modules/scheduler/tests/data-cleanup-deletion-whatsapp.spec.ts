/**
 * GAP-A G058/G059: WhatsApp deletion reminders — focused tests.
 *
 * Covers:
 *  1. WhatsApp reminder is sent to the verified phone when the gateway is
 *     present (mocked), and the in-app/email path still runs.
 *  2. When OtpGatewayService is absent (@Optional in production wiring),
 *     the reminder still completes (in-app + flag) without crashing.
 *  3. Gateway send failure does NOT fail the reminder — flag is still set.
 *
 * decryptPiiSafe is mocked: real AES keys are not available in tests.
 */
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';

import { DataCleanupService } from '../services/data-cleanup.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { OtpGatewayService } from '../../auth/otp-gateway.service';
import { AccountDeletionService } from '../../users/account-deletion.service';
import { EMAIL_QUEUE } from '../../queue/processors/email.processor';

jest.mock('../../../common/utils/pii.util', () => {
  const actual = jest.requireActual('../../../common/utils/pii.util');
  return {
    ...actual,
    decryptPiiSafe: jest.fn(async (v: string | null | undefined) =>
      v ? '+6281234567890' : null,
    ),
  };
});

describe('DataCleanupService deletion WhatsApp reminders (GAP-A G058/G059)', () => {
  const req7d = {
    id: 'req-7d',
    userId: 'user-7d',
    referenceCode: 'KDEL-ABC123',
    purgeAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
  };

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

  async function buildService(gateway: any | undefined): Promise<DataCleanupService> {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockPrisma));
    const providers: any[] = [
      DataCleanupService,
      { provide: PrismaService, useValue: mockPrisma },
      { provide: RedisService, useValue: mockRedis },
      { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
      { provide: getQueueToken(EMAIL_QUEUE), useValue: mockEmailQueue },
      // SEC-001: re-check eligibilitas — mock selalu eligible di spec reminder ini.
      {
        provide: AccountDeletionService,
        useValue: { getDeletionEligibility: jest.fn().mockResolvedValue({ eligible: true, blockers: [] }) },
      },
    ];
    if (gateway !== undefined) {
      providers.push({ provide: OtpGatewayService, useValue: gateway });
    }
    const module: TestingModule = await Test.createTestingModule({ providers }).compile();
    return module.get<DataCleanupService>(DataCleanupService);
  }

  function primeReminderMocks() {
    mockPrisma.accountDeletionRequest.findMany
      .mockResolvedValueOnce([req7d])
      .mockResolvedValueOnce([]);
    mockPrisma.accountDeletionRequest.findUnique.mockResolvedValue({
      status: 'REQUESTED',
      reminder7dSent: false,
      reminder1dSent: false,
    });
    mockRedis.setNx.mockResolvedValue(true);
    mockPrisma.user.findUnique.mockResolvedValue({
      email: 'user@example.com',
      phoneNumber: 'encrypted-payload',
      phoneVerified: true,
    });
  }

  it('mengirim WhatsApp ke nomor terverifikasi bila gateway tersedia', async () => {
    const gateway = { sendTextMessage: jest.fn().mockResolvedValue({ success: true }) };
    const service = await buildService(gateway);
    primeReminderMocks();

    const { sent7d } = await (service as any).processDeletionReminders();

    expect(sent7d).toBe(1);
    expect(gateway.sendTextMessage).toHaveBeenCalledWith(
      '+6281234567890',
      expect.stringContaining('KDEL-ABC123'),
    );
    expect(gateway.sendTextMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Akun dihapus? Pulihkan di sini'),
    );
    // In-app + flag tetap jalan.
    expect(mockPrisma.notification.create).toHaveBeenCalled();
    expect(mockPrisma.accountDeletionRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-7d' },
      data: { reminder7dSent: true },
    });
  });

  it('reminder tetap jalan tanpa gateway (Optional) — tidak crash', async () => {
    const service = await buildService(undefined);
    primeReminderMocks();

    const { sent7d } = await (service as any).processDeletionReminders();

    expect(sent7d).toBe(1);
    expect(mockPrisma.notification.create).toHaveBeenCalled();
    expect(mockPrisma.accountDeletionRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-7d' },
      data: { reminder7dSent: true },
    });
  });

  it('kegagalan WhatsApp TIDAK menggagalkan reminder (flag tetap diset)', async () => {
    const gateway = {
      sendTextMessage: jest.fn().mockResolvedValue({ success: false, error: 'provider down' }),
    };
    const service = await buildService(gateway);
    primeReminderMocks();

    const { sent7d } = await (service as any).processDeletionReminders();

    expect(sent7d).toBe(1);
    expect(mockPrisma.accountDeletionRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-7d' },
      data: { reminder7dSent: true },
    });
  });

  it('tidak mengirim WhatsApp bila nomor tidak terverifikasi', async () => {
    const gateway = { sendTextMessage: jest.fn().mockResolvedValue({ success: true }) };
    const service = await buildService(gateway);
    primeReminderMocks();
    mockPrisma.user.findUnique.mockResolvedValue({
      email: 'user@example.com',
      phoneNumber: 'encrypted-payload',
      phoneVerified: false,
    });

    const { sent7d } = await (service as any).processDeletionReminders();

    expect(sent7d).toBe(1);
    expect(gateway.sendTextMessage).not.toHaveBeenCalled();
  });
});
