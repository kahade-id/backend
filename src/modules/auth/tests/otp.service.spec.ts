import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OtpService } from '../otp.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';

const mockPrisma = {
  otpCode: {
    create: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockPrisma)),
};

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn().mockResolvedValue(undefined),
  incr: jest.fn(),
  expire: jest.fn(),
  setNx: jest.fn(),
};

describe('OtpService', () => {
  let service: OtpService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OtpService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(5) } },
      ],
    }).compile();

    service = module.get<OtpService>(OtpService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateOtp', () => {
    it('should generate a 6-digit numeric OTP', async () => {
      mockRedis.setNx.mockResolvedValue(true);
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp-1' });

      const otp = await service.generateOtp('user@example.com', 'EMAIL_VERIFY' as any);
      expect(otp).toMatch(/^\d{6}$/);
    });

    it('should store OTP record in DB via PrismaService', async () => {
      mockRedis.setNx.mockResolvedValue(true);
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp-2' });

      await service.generateOtp('user@example.com', 'PASSWORD_RESET' as any);
      expect(mockPrisma.otpCode.create).toHaveBeenCalledTimes(1);
      const createArgs = mockPrisma.otpCode.create.mock.calls[0][0].data;
      expect(createArgs.email).toBe('user@example.com');
      expect(createArgs.type).toBe('PASSWORD_RESET');
    });

    it('should atomically claim cooldown in Redis before generating OTP', async () => {
      mockRedis.setNx.mockResolvedValue(true);
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp-3' });

      await service.generateOtp('user@example.com', 'EMAIL_VERIFY' as any);
      expect(mockRedis.setNx).toHaveBeenCalledWith(
        expect.stringContaining('otp_cooldown:'),
        '1',
        60,
      );
    });

    it('should throw TooManyRequestsException when atomic cooldown claim loses', async () => {
      mockRedis.setNx.mockResolvedValue(false);
      await expect(
        service.generateOtp('user@example.com', 'EMAIL_VERIFY' as any),
      ).rejects.toThrow();
      expect(mockPrisma.otpCode.create).not.toHaveBeenCalled();
      expect(mockRedis.incr).not.toHaveBeenCalled();
    });

    it('should invalidate prior active email OTPs before storing a replacement', async () => {
      mockRedis.setNx.mockResolvedValue(true);
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp-replacement' });

      await service.generateOtp('user@example.com', 'EMAIL_VERIFY' as any);

      expect(mockPrisma.otpCode.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'user@example.com', type: 'EMAIL_VERIFY', isUsed: false },
          data: expect.objectContaining({ isUsed: true }),
        }),
      );
    });

    it('should release cooldown when OTP persistence fails', async () => {
      mockRedis.setNx.mockResolvedValue(true);
      mockPrisma.otpCode.create.mockRejectedValue(new Error('database unavailable'));
      await expect(
        service.generateOtp('user@example.com', 'EMAIL_VERIFY' as any),
      ).rejects.toThrow('database unavailable');
      expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining('otp_cooldown:'));
    });
  });

  describe('verifyOtp', () => {
    it('should return false when no eligible OTP row found', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(null);
      const result = await service.verifyOtp('user@example.com', 'EMAIL_VERIFY' as any, '123456');
      expect(result).toBe(false);
    });

    it('should return false when row is claimed between findFirst and updateMany (count=0)', async () => {
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash('999999', 10);
      mockPrisma.otpCode.findFirst.mockResolvedValue({ id: 'otp-1', code: hash });
      mockPrisma.otpCode.updateMany.mockResolvedValue({ count: 0 });
      const result = await service.verifyOtp('user@example.com', 'EMAIL_VERIFY' as any, '123456');
      expect(result).toBe(false);
    });

    it('should return false for incorrect OTP code', async () => {
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash('999999', 10);
      mockPrisma.otpCode.findFirst.mockResolvedValue({ id: 'otp-1', code: hash });
      mockPrisma.otpCode.updateMany.mockResolvedValue({ count: 1 });
      const result = await service.verifyOtp('user@example.com', 'EMAIL_VERIFY' as any, '123456');
      expect(result).toBe(false);
    });

    it('should return true for correct OTP and mark it as used', async () => {
      const bcrypt = require('bcrypt');
      const correctOtp = '654321';
      const hash = await bcrypt.hash(correctOtp, 10);
      mockPrisma.otpCode.findFirst.mockResolvedValue({ id: 'otp-1', code: hash, email: 'user@example.com', type: 'EMAIL_VERIFY' });
      mockPrisma.otpCode.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      const result = await service.verifyOtp('user@example.com', 'EMAIL_VERIFY' as any, correctOtp);
      expect(result).toBe(true);
      expect(mockPrisma.otpCode.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isUsed: true }) }),
      );
    });

    it('should return false when final isUsed claim lost to concurrent request', async () => {
      const bcrypt = require('bcrypt');
      const correctOtp = '654321';
      const hash = await bcrypt.hash(correctOtp, 10);
      mockPrisma.otpCode.findFirst.mockResolvedValue({ id: 'otp-1', code: hash });
      mockPrisma.otpCode.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      const result = await service.verifyOtp('user@example.com', 'EMAIL_VERIFY' as any, correctOtp);
      expect(result).toBe(false);
    });

    it('should use latest OTP row when multiple active rows exist (resend scenario)', async () => {
      const bcrypt = require('bcrypt');
      const correctOtp = '654321';
      const hash = await bcrypt.hash(correctOtp, 10);
      mockPrisma.otpCode.findFirst.mockResolvedValue({ id: 'otp-latest', code: hash, email: 'user@example.com', type: 'EMAIL_VERIFY' });
      mockPrisma.otpCode.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      const result = await service.verifyOtp('user@example.com', 'EMAIL_VERIFY' as any, correctOtp);
      expect(result).toBe(true);
      expect(mockPrisma.otpCode.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'otp-latest' }) }),
      );
    });
  });

  describe('generatePhoneOtp', () => {
    it('should invalidate prior active phone OTPs before storing a replacement', async () => {
      mockRedis.setNx.mockResolvedValue(true);
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'phone-otp-replacement' });

      await service.generatePhoneOtp('+628123456789', 'PHONE_LOGIN' as any, 'WHATSAPP' as any);

      expect(mockPrisma.otpCode.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { phone: '+628123456789', type: 'PHONE_LOGIN', isUsed: false },
          data: expect.objectContaining({ isUsed: true }),
        }),
      );
    });

    it('should reject a cooldown repeat before consuming phone or IP rate quota', async () => {
      mockRedis.setNx.mockResolvedValue(false);

      await expect(
        service.generatePhoneOtp('+628123456789', 'PHONE_LOGIN' as any, 'WHATSAPP' as any, undefined, undefined, '127.0.0.1'),
      ).rejects.toThrow();

      expect(mockRedis.incr).not.toHaveBeenCalled();
      expect(mockPrisma.otpCode.create).not.toHaveBeenCalled();
    });
  });
});
