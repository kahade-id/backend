import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OtpTriggerService } from '../otp-trigger.service';
import { OtpTriggerPurpose } from '../dto/otp-trigger.dto';
import { initializeCrypto } from '../../../common/utils/crypto.util';
import { OpsSettingsService } from '../../ops-settings/ops-settings.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { OtpService } from '../otp.service';
import { OtpGatewayService } from '../otp-gateway.service';
import { TokenService } from '../token.service';
import { AuthLocationService } from '../auth-location.service';
import { OTP_TRIGGER } from '../../../common/constants/redis-keys';
import { OtpType } from '@prisma/client';

describe('OtpTriggerService', () => {
  let service: OtpTriggerService;

  const mockRedis = {
    get: jest.fn(),
    set: jest.fn(),
    setNx: jest.fn(),
    incrWithTtl: jest.fn(),
    del: jest.fn(),
  };
  const mockOtpService = {
    generatePhoneOtp: jest.fn(),
    invalidatePhoneOtps: jest.fn().mockResolvedValue(undefined),
  };
  const mockOtpGateway = {
    sendOtp: jest.fn(),
  };
  const mockConfig = {
    get: jest.fn((key: string) => (key === 'FONNTE_WEBHOOK_SECRET' ? 'test-secret' : undefined)),
  };
  // OPS: webhook secret kini dibaca via OpsSettingsService (DB panel > .env).
  const mockOpsSettings = {
    get: jest.fn((key: string) => (key === 'FONNTE_WEBHOOK_SECRET' ? 'test-secret' : undefined)),
    getSecret: jest.fn((key: string) => (key === 'FONNTE_WEBHOOK_SECRET' ? 'test-secret' : undefined)),
    has: jest.fn((key: string) => key === 'FONNTE_WEBHOOK_SECRET'),
  };

  const baseDto = {
    phoneNumber: '081234567890',
    purpose: OtpTriggerPurpose.REGISTER,
    deviceId: 'device-1',
  };

  beforeEach(async () => {
    initializeCrypto({ aesSecretKey: 'test-aes-secret', hmacSecretKey: 'test-hmac-secret' });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OtpTriggerService,
        { provide: PrismaService, useValue: { user: { findFirst: jest.fn() } } },
        { provide: RedisService, useValue: mockRedis },
        { provide: OtpService, useValue: mockOtpService },
        { provide: OtpGatewayService, useValue: mockOtpGateway },
        { provide: TokenService, useValue: {} },
        { provide: AuthLocationService, useValue: { logEvent: jest.fn() } },
        { provide: ConfigService, useValue: mockConfig },
        { provide: OpsSettingsService, useValue: mockOpsSettings },
      ],
    }).compile();

    service = module.get<OtpTriggerService>(OtpTriggerService);
    jest.clearAllMocks();
    mockConfig.get.mockImplementation(
      (key: string) => (key === 'FONNTE_WEBHOOK_SECRET' ? 'test-secret' : undefined),
    );
    mockOpsSettings.getSecret.mockImplementation(
      (key: string) => (key === 'FONNTE_WEBHOOK_SECRET' ? 'test-secret' : undefined),
    );
  });

  describe('createTrigger', () => {
    it('menghasilkan refCode 12 hex uppercase', async () => {
      mockRedis.setNx.mockResolvedValue(true);
      mockRedis.incrWithTtl.mockResolvedValue(1);
      mockRedis.get.mockResolvedValue(null); // refCode unik
      mockRedis.set.mockResolvedValue('OK');

      const result = await service.createTrigger(baseDto, '127.0.0.1');

      expect(result.refCode).toMatch(/^[A-F0-9]{12}$/);
      expect(result.triggerText).toBe(`KAHADE ${result.refCode}`);
      expect(result.whatsappUrl).toContain('6285786035715');
      expect(result.expiresInSeconds).toBe(600);
    });

    it('menolak bila cooldown nomor masih aktif', async () => {
      mockRedis.setNx.mockResolvedValue(false); // cooldown key sudah ada

      await expect(service.createTrigger(baseDto, '127.0.0.1')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockRedis.incrWithTtl).not.toHaveBeenCalled();
    });

    it('menolak nomor non-Indonesia', async () => {
      await expect(
        service.createTrigger({ ...baseDto, phoneNumber: '+15551234567' }, '127.0.0.1'),
      ).rejects.toThrow();
    });
  });

  describe('verifyWebhookSecret', () => {
    it('menerima secret yang benar', () => {
      expect(service.verifyWebhookSecret('test-secret')).toBe(true);
    });

    it('menolak secret salah atau kosong bila secret server diset', () => {
      expect(service.verifyWebhookSecret('wrong')).toBe(false);
      expect(service.verifyWebhookSecret(undefined)).toBe(false);
    });

    it('mengizinkan dengan peringatan bila secret server belum diset (fail-open terdokumentasi)', () => {
      mockConfig.get.mockReturnValue(undefined);
      mockOpsSettings.getSecret.mockReturnValue(undefined);
      mockOpsSettings.get.mockReturnValue(undefined);
      expect(service.verifyWebhookSecret('test-secret')).toBe(true);
      expect(service.verifyWebhookSecret(undefined)).toBe(true);
    });
  });

  describe('handleFonnteWebhook', () => {
    const waitingRecord = (overrides = {}) => ({
      phoneNumber: '+6281234567890',
      deviceId: 'device-1',
      purpose: OtpTriggerPurpose.REGISTER,
      status: 'WAITING',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ...overrides,
    });

    beforeEach(() => {
      mockRedis.setNx.mockResolvedValue(true);
    });

    it('mengabaikan pesan tanpa kode trigger', async () => {
      await service.handleFonnteWebhook({ sender: '6281234567890', message: 'halo' });
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('mengabaikan bila nomor pengirim tidak cocok (sender mismatch)', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(waitingRecord()));

      await service.handleFonnteWebhook({
        sender: '628999888777',
        message: 'KAHADE ABCDEF123456',
        inboxid: 'inbox-1',
      });

      expect(mockOtpService.generatePhoneOtp).not.toHaveBeenCalled();
      // record tetap WAITING — tidak ditandai COMPLETED/FAILED
      const setCalls = mockRedis.set.mock.calls.filter(([k]: string[]) => k === OTP_TRIGGER('ABCDEF123456'));
      expect(setCalls).toHaveLength(0);
    });

    it('idempoten: inboxid yang sama tidak diproses dua kali', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(waitingRecord()));
      mockRedis.setNx
        .mockResolvedValueOnce(true) // inbox dedup: pertama
        .mockResolvedValueOnce(false); // inbox dedup: duplikat
      mockOtpService.generatePhoneOtp.mockResolvedValue('123456');
      mockOtpGateway.sendOtp.mockResolvedValue({ success: true });

      const body = { sender: '6281234567890', message: 'KAHADE ABCDEF123456', inboxid: 'inbox-dup' };
      await service.handleFonnteWebhook(body);
      await service.handleFonnteWebhook(body);

      expect(mockOtpService.generatePhoneOtp).toHaveBeenCalledTimes(1);
    });

    it('menandai COMPLETED hanya setelah OTP terkirim', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(waitingRecord()));
      mockOtpService.generatePhoneOtp.mockResolvedValue('123456');
      mockOtpGateway.sendOtp.mockResolvedValue({ success: true });

      await service.handleFonnteWebhook({
        sender: '6281234567890',
        message: 'KAHADE ABCDEF123456',
        inboxid: 'inbox-2',
      });

      const setCalls = mockRedis.set.mock.calls.filter(([k]: string[]) => k === OTP_TRIGGER('ABCDEF123456'));
      expect(setCalls).toHaveLength(1);
      expect(JSON.parse(setCalls[0][1]).status).toBe('COMPLETED');
    });

    it('menandai FAILED (bukan COMPLETED) bila pengiriman gagal', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(waitingRecord()));
      mockOtpService.generatePhoneOtp.mockResolvedValue('123456');
      mockOtpGateway.sendOtp.mockResolvedValue({ success: false, error: 'DOWN' });

      await service.handleFonnteWebhook({
        sender: '6281234567890',
        message: 'KAHADE ABCDEF123456',
        inboxid: 'inbox-3',
      });

      const setCalls = mockRedis.set.mock.calls.filter(([k]: string[]) => k === OTP_TRIGGER('ABCDEF123456'));
      expect(setCalls).toHaveLength(1);
      expect(JSON.parse(setCalls[0][1]).status).toBe('FAILED');
      expect(mockOtpService.invalidatePhoneOtps).toHaveBeenCalledWith(
        '+6281234567890',
        OtpType.PHONE_LOGIN,
      );
    });

    it('mengabaikan pesan untuk record yang sudah COMPLETED', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(waitingRecord({ status: 'COMPLETED' })));

      await service.handleFonnteWebhook({
        sender: '6281234567890',
        message: 'KAHADE ABCDEF123456',
        inboxid: 'inbox-4',
      });

      expect(mockOtpService.generatePhoneOtp).not.toHaveBeenCalled();
    });
  });

  describe('getTriggerStatus', () => {
    it('mengembalikan EXPIRED untuk refCode malformed', async () => {
      await expect(service.getTriggerStatus('pendek')).resolves.toEqual({ status: 'EXPIRED' });
      expect(mockRedis.get).not.toHaveBeenCalled();
    });
  });
});
