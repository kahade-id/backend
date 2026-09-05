import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';
import { AuthService } from '../auth.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { TokenService } from '../token.service';
import { OtpService } from '../otp.service';
import { OtpGatewayService } from '../otp-gateway.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { EMAIL_QUEUE } from '../../queue/processors/email.processor';
import { OtpType } from '@prisma/client';
import { bcryptHash, encryptAES, initializeCrypto } from '../../../common/utils/crypto.util';
import * as speakeasy from 'speakeasy';

const mockUser = {
  id: 'db-id-1',
  userId: 'usr_abc123',
  email: 'user@example.com',
  password: '$2b$12$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36WQoeG6Lruj3vjPGga31lW',
  fullName: 'Test User',
  username: null,
  isActive: true,
  isBanned: false,
  emailVerified: false,
  failedLoginAttempts: 0,
  lockedUntil: null,
  kycStatus: 'PENDING',
  isKahadePlus: false,
  membershipRank: 'BASIC',
};

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  wallet: {
    create: jest.fn(),
  },
  notificationPreference: {
    create: jest.fn(),
  },
  referralCode: {
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  twoFactorAuth: {
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  userSession: {
    create: jest.fn().mockResolvedValue({ id: 'session-1' }),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    update: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
  },
  userDevice: {
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  },
  otpCode: {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
  },
  notification: {
    create: jest.fn().mockResolvedValue({}),
  },
  emitNotificationCreated: jest.fn(),
  passwordHistory: {
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    deleteMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  incr: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(1),
  setNx: jest.fn(),
  releaseLock: jest.fn().mockResolvedValue(true),
  getPrefix: jest.fn().mockReturnValue('test:'),
  getClient: jest.fn(),
};

const mockTokenService = {
  signAccessToken: jest.fn().mockReturnValue('access-token-123'),
  signRefreshToken: jest.fn().mockReturnValue('refresh-token-123'),
  signTempToken: jest.fn().mockReturnValue('temp-token-123'),
  verifyRefreshToken: jest.fn(),
  verifyTempToken: jest.fn(),
  decodeToken: jest.fn().mockReturnValue({ sub: 'user-1', jti: 'jti-mock-123' }),
  getAccessTokenTtlSeconds: jest.fn().mockReturnValue(900),
};

const mockOtpService = {
  generateOtp: jest.fn().mockResolvedValue('123456'),
  generatePhoneOtp: jest.fn().mockResolvedValue('123456'),
  verifyOtp: jest.fn().mockResolvedValue(true),
  verifyPhoneOtp: jest.fn().mockResolvedValue(true),
  verifyPhoneOtpWithMetadata: jest.fn(),
  consumeVerifiedOtp: jest.fn(),
  invalidatePhoneOtps: jest.fn().mockResolvedValue(undefined),
  invalidateOtps: jest.fn().mockResolvedValue(undefined),
};

const mockConfig = {
  get: jest.fn((key: string) => {
    const values: Record<string, unknown> = {
      'jwt.expiresIn': '15m',
      'jwt.secret': 'test-secret',
    };
    return values[key];
  }),
};

const mockAuditLog = {
  logUserAction: jest.fn(),
};

const mockEmailQueue = {
  add: jest.fn().mockResolvedValue({ id: 'job-1' }),
};

const mockOtpGateway = {
  sendOtp: jest.fn().mockResolvedValue({ success: true, messageId: 'mock' }),
  supportsMethod: jest.fn().mockReturnValue(true),
};

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    initializeCrypto({ aesSecretKey: 'test-aes-secret', hmacSecretKey: 'test-hmac-secret' });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: TokenService, useValue: mockTokenService },
        { provide: OtpService, useValue: mockOtpService },
        { provide: OtpGatewayService, useValue: mockOtpGateway },
        { provide: ConfigService, useValue: mockConfig },
        { provide: AuditLogService, useValue: mockAuditLog },
        { provide: RealtimeService, useValue: { emitToUser: jest.fn(), emitToRoom: jest.fn() } },
        { provide: getQueueToken(EMAIL_QUEUE), useValue: mockEmailQueue },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
    mockRedis.setex.mockResolvedValue('OK');
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('phone number change', () => {
    it('rejects an OTP whose bound owner does not match the authenticated user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1', email: 'user@example.com', isActive: true, isBanned: false,
      });
      mockOtpService.verifyPhoneOtpWithMetadata.mockResolvedValue({
        valid: true,
        otpId: 'otp-1',
        metadata: { purpose: 'phone_change', userId: 'another-user', phoneHash: 'hash' },
      });

      await expect(service.confirmPhoneChange('user-1', '+6281234567890', '123456'))
        .rejects.toThrow(BadRequestException);
      expect(mockOtpService.consumeVerifiedOtp).not.toHaveBeenCalled();
    });

    it('does not consume a phone-change OTP for an inactive account', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1', email: 'user@example.com', isActive: false, isBanned: false,
      });

      await expect(service.confirmPhoneChange('user-1', '+6281234567890', '123456'))
        .rejects.toThrow(UnauthorizedException);

      expect(mockOtpService.verifyPhoneOtpWithMetadata).not.toHaveBeenCalled();
      expect(mockOtpService.consumeVerifiedOtp).not.toHaveBeenCalled();
    });

    it('consumes a bound OTP, revokes sessions, and removes trusted devices after a phone change', async () => {
      const phone = '+6281234567890';
      const phoneHash = require('../../../common/utils/pii.util').hashPhoneNumber(phone);
      mockOtpService.verifyPhoneOtpWithMetadata.mockResolvedValue({
        valid: true,
        otpId: 'otp-1',
        metadata: { purpose: 'phone_change', userId: 'user-1', phoneHash },
      });
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com', isActive: true, isBanned: false });
      const tx = {
        otpCode: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        user: {
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest.fn().mockResolvedValue({}),
        },
        userSession: {
          findMany: jest.fn().mockResolvedValue([{ id: 'session-1' }]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        userDevice: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx));

      await expect(service.confirmPhoneChange('user-1', phone, '123456')).resolves.toEqual({
        message: 'Phone number updated. Please log in again on your devices.',
      });
      expect(mockOtpService.consumeVerifiedOtp).not.toHaveBeenCalled();
      expect(tx.otpCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'otp-1', isUsed: false },
        data: expect.objectContaining({ isUsed: true, usedAt: expect.any(Date) }),
      });
      expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ phoneVerified: true }),
      }));
      expect(tx.userSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ revokedReason: 'phone_changed' }),
      }));
      expect(tx.userDevice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: { isTrusted: false, trustedAt: null },
      }));
      expect(mockRedis.setex).toHaveBeenCalledWith('session_revoked:session-1', 900, '1', { throwOnError: true });
    });
  });

  describe('credential change reauthentication', () => {
    it('requires the configured second factor before replacing an unverified email address', async () => {
      const passwordHash = await bcryptHash('Password123!', 12);
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ ...mockUser, password: passwordHash, emailVerified: false })
        .mockResolvedValueOnce(null);
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue({ isEnabled: true, secret: 'unused-for-missing-code' });

      await expect(service.correctEmail('db-id-1', 'new@example.com', 'Password123!'))
        .rejects.toMatchObject({ response: { code: 'TWO_FA_REQUIRED' } });

      expect(mockOtpService.invalidateOtps).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('requires the configured second factor before changing a password', async () => {
      const passwordHash = await bcryptHash('Password123!', 12);
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser, password: passwordHash });
      mockPrisma.passwordHistory.findMany.mockResolvedValue([]);
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue({ isEnabled: true, secret: 'unused-for-missing-code' });

      await expect(service.changePassword('db-id-1', {
        currentPassword: 'Password123!',
        newPassword: 'AnotherPassword123!',
        confirmPassword: 'AnotherPassword123!',
      } as any)).rejects.toMatchObject({ response: { code: 'TWO_FA_REQUIRED' } });

      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
    });

    it('revokes trusted devices after a successful email change', async () => {
      const passwordHash = await bcryptHash('Password123!', 12);
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ ...mockUser, password: passwordHash, emailVerified: false })
        .mockResolvedValueOnce(null);
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue(null);
      mockPrisma.userSession.findMany.mockResolvedValue([{ id: 'session-email-change' }]);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userDevice.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.$transaction.mockImplementation(async (callback: (client: typeof mockPrisma) => unknown) => callback(mockPrisma));

      await expect(service.correctEmail('db-id-1', 'new@example.com', 'Password123!'))
        .resolves.toMatchObject({ message: expect.stringContaining('Email address updated') });

      expect(mockPrisma.userDevice.updateMany).toHaveBeenCalledWith({
        where: { userId: 'db-id-1', isTrusted: true },
        data: { isTrusted: false, trustedAt: null },
      });
      expect(mockRedis.setex).toHaveBeenCalledWith('session_revoked:session-email-change', 900, '1', { throwOnError: true });
    });
  });

  // ─── register ────────────────────────────────────────────────────

  describe('register', () => {
    it('should throw BadRequestException when passwords do not match', async () => {
      await expect(
        service.register({
          fullName: 'Test User',
          email: 'test@example.com',
          password: 'Password123!',
          confirmPassword: 'Different123!',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should return ambiguous success message when user already exists (anti-enumeration)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);

      const result = await service.register({
        fullName: 'Test User',
        email: 'user@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      });

      expect(result.message).toBeTruthy();
    });

    it('should create user and return success message for new email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
      );
      mockPrisma.user.create.mockResolvedValue(mockUser);
      mockPrisma.wallet.create.mockResolvedValue({});
      mockPrisma.notificationPreference.create.mockResolvedValue({});
      mockPrisma.referralCode.create.mockResolvedValue({});
      mockEmailQueue.add.mockResolvedValue({ id: 'job-1' });
      mockOtpService.generateOtp.mockResolvedValue('654321');

      const result = await service.register({
        fullName: 'New User',
        email: 'new@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      });

      expect(result.message).toBeTruthy();
    });
  });

  describe('session limit', () => {
    it('evicts only active unexpired sessions', async () => {
      mockPrisma.userSession.count.mockResolvedValue(5);
      mockPrisma.userSession.findMany.mockResolvedValue([{ id: 'session-old' }]);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({ id: 'session-new' });
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
      );

      await (service as unknown as { saveSession: (...args: string[]) => Promise<string> }).saveSession(
        'db-id-1',
        'refresh-token',
        'test-device',
        '127.0.0.1',
      );

      expect(mockPrisma.userSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            expiresAt: expect.objectContaining({ gt: expect.any(Date) }),
          }),
        }),
      );
    });

    it('revokes an earlier active session on the same device before issuing a new session', async () => {
      mockPrisma.userSession.findMany.mockResolvedValue([{ id: 'same-device-session' }]);
      mockPrisma.userSession.count.mockResolvedValue(1);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({ id: 'session-new' });
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
      );

      await (service as unknown as { saveSession: (...args: string[]) => Promise<string> }).saveSession(
        'db-id-1', 'refresh-token', 'same-device', '127.0.0.1',
      );

      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['same-device-session'] }, isRevoked: false }),
        data: expect.objectContaining({ isRevoked: true, revokedReason: 'device_reauthenticated' }),
      }));
      expect(mockRedis.setex).toHaveBeenCalledWith('session_revoked:same-device-session', 900, '1', { throwOnError: true });
    });
  });

  // ─── login ───────────────────────────────────────────────────────

  describe('phone OTP login', () => {
    it('does not consume a valid OTP when account lookup fails before verification', async () => {
      const schemaFailure = new Error('The column users.language does not exist');
      mockPrisma.user.findFirst.mockRejectedValue(schemaFailure);

      await expect(
        service.verifyPhoneOtp('+628123456789', '123456', 'device-abc', 'Test Browser', '127.0.0.1'),
      ).rejects.toThrow(schemaFailure);

      expect(mockOtpService.verifyPhoneOtpWithMetadata).not.toHaveBeenCalled();
    });

    it('rejects a phone OTP login while the account is temporarily locked', async () => {
      mockOtpService.verifyPhoneOtpWithMetadata.mockResolvedValue({
        valid: true,
        otpId: 'otp-1',
        metadata: { purpose: 'phone_login', deviceId: 'device-abc' },
      });
      mockPrisma.user.findFirst.mockResolvedValue({
        ...mockUser,
        lockedUntil: new Date(Date.now() + 60_000),
      });

      await expect(
        service.verifyPhoneOtp('+628123456789', '123456', 'device-abc', 'Test Browser', '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockOtpService.verifyPhoneOtpWithMetadata).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('rejects a valid phone OTP presented from a device other than the requesting device without consuming it', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockOtpService.verifyPhoneOtpWithMetadata.mockResolvedValue({
        valid: true,
        otpId: 'otp-1',
        metadata: { purpose: 'phone_login', deviceId: 'device-origin' },
      });

      await expect(
        service.verifyPhoneOtp('+628123456789', '123456', 'device-other', 'Test Browser', '127.0.0.1'),
      ).rejects.toThrow(BadRequestException);

      expect(mockOtpService.consumeVerifiedOtp).not.toHaveBeenCalled();
      expect(mockTokenService.signTempToken).not.toHaveBeenCalled();
    });

    it('binds a successful new-user phone verification token to the requesting device', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockOtpService.verifyPhoneOtpWithMetadata.mockResolvedValue({
        valid: true,
        otpId: 'otp-1',
        metadata: { purpose: 'phone_login', deviceId: 'device-abc' },
      });
      mockOtpService.consumeVerifiedOtp.mockResolvedValue(true);

      await expect(
        service.verifyPhoneOtp('+628123456789', '123456', 'device-abc', 'Test Browser', '127.0.0.1'),
      ).resolves.toMatchObject({ status: 'new_user', tempToken: 'temp-token-123' });

      expect(mockTokenService.signTempToken).toHaveBeenCalledWith({
        sub: '+628123456789',
        scope: 'phone_register',
        deviceId: 'device-abc',
      });
    });

    it('fails closed when the OTP provider cannot deliver the code', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockOtpService.generatePhoneOtp.mockResolvedValue('123456');
      mockOtpGateway.supportsMethod.mockReturnValue(true);
      mockOtpGateway.sendOtp.mockResolvedValue({ success: false, error: 'OTP_DELIVERY_NETWORK_ERROR' });

      await expect(
        service.requestPhoneOtp('+628123456789', 'WHATSAPP', '127.0.0.1'),
      ).rejects.toMatchObject({
        status: 503,
        response: expect.objectContaining({ code: 'OTP_DELIVERY_FAILED' }),
      });
      expect(mockOtpService.invalidatePhoneOtps).toHaveBeenCalledWith('+628123456789', OtpType.PHONE_LOGIN);
    });

    it('cleans up and fails closed when the OTP provider throws', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockOtpService.generatePhoneOtp.mockResolvedValue('123456');
      mockOtpGateway.supportsMethod.mockReturnValue(true);
      mockOtpGateway.sendOtp.mockRejectedValue(new Error('provider timeout'));

      await expect(
        service.requestPhoneOtp('+628123456789', 'WHATSAPP', '127.0.0.1'),
      ).rejects.toMatchObject({
        status: 503,
        response: expect.objectContaining({ code: 'OTP_DELIVERY_FAILED' }),
      });
      expect(mockOtpService.invalidatePhoneOtps).toHaveBeenCalledWith('+628123456789', OtpType.PHONE_LOGIN);
    });

    it('does not write the raw phone number to delivery-failure logs', async () => {
      const phone = '+628123456789';
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockOtpService.generatePhoneOtp.mockResolvedValue('123456');
      mockOtpGateway.supportsMethod.mockReturnValue(true);
      mockOtpGateway.sendOtp.mockRejectedValue(new Error('provider timeout'));
      const errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

      await expect(service.requestPhoneOtp(phone, 'WHATSAPP', '127.0.0.1')).rejects.toMatchObject({ status: 503 });

      expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain(phone);
    });
  });

  describe('login', () => {
    const loginDto = {
      email: 'user@example.com',
      password: 'CorrectPassword123!',
      deviceId: 'device-abc',
      deviceInfo: 'Test Browser',
    };

    it('should normalize email before looking up the account', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login({ ...loginDto, email: '  USER@EXAMPLE.COM  ' }, '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'user@example.com' },
      });
    });

    it('should throw UnauthorizedException when user does not exist (timing-safe)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login(loginDto, '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when account is banned (anti-enumeration)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser, isBanned: true });

      await expect(
        service.login(loginDto, '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when account is locked', async () => {
      const futureDate = new Date(Date.now() + 30 * 60 * 1000);
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUser,
        lockedUntil: futureDate,
      });

      await expect(
        service.login(loginDto, '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should revoke active sessions when repeated failures permanently lock the account', async () => {
      const bcryptHash = require('bcrypt');
      const hashedPassword = await bcryptHash.hash('RealPassword123!', 12);
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUser,
        password: hashedPassword,
      });
      mockPrisma.user.update
        .mockResolvedValueOnce({ failedLoginAttempts: 5 })
        .mockResolvedValue({});
      mockRedis.incr.mockResolvedValue(5);
      mockPrisma.userSession.findMany.mockResolvedValue([{ id: 'session-1' }]);
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
      );

      await expect(
        service.login({ ...loginDto, password: 'WrongPassword!' }, '127.0.0.1'),
      ).rejects.toThrow('permanently locked');

      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'db-id-1', isRevoked: false },
          data: expect.objectContaining({ revokedReason: 'account_permanently_locked' }),
        }),
      );
    });

    it('should throw UnauthorizedException for wrong password and increment failedLoginAttempts', async () => {
      const bcryptHash = require('bcrypt');
      const hashedPassword = await bcryptHash.hash('RealPassword123!', 12);

      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUser,
        password: hashedPassword,
      });
      mockPrisma.user.update.mockResolvedValue({});

      await expect(
        service.login({ ...loginDto, password: 'WrongPassword!' }, '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ failedLoginAttempts: { increment: 1 } }),
        }),
      );
    });

    it('should return tokens for valid credentials without 2FA', async () => {
      const bcryptHash = require('bcrypt');
      const hashedPassword = await bcryptHash.hash('CorrectPassword123!', 12);

      const fullMockUser = {
        ...mockUser,
        password: hashedPassword,
        emailVerified: true,
        avatarUrl: null,
        bio: null,
        accountType: 'PERSONAL',
        isKahadePlus: false,
        subscriptionExpiresAt: null,
        membershipRank: 'BASIC',
        phoneNumber: null,
        phoneVerified: false,
        dateOfBirth: null,
        gender: null,
        createdAt: new Date(),
        lastLoginAt: null,
        lastLoginIp: null,
      };

      mockPrisma.user.findUnique.mockResolvedValue(fullMockUser);
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue(null);
      mockPrisma.user.update.mockResolvedValue(fullMockUser);
      mockPrisma.userSession.create.mockResolvedValue({ id: 'session-1' });
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
      );
      mockTokenService.signRefreshToken.mockReturnValue('refresh-token');
      mockTokenService.signAccessToken.mockReturnValue('access-token');
      mockTokenService.decodeToken.mockReturnValue({ sub: 'db-id-1', jti: 'jti-mock-123' });

      const result = await service.login(
        { ...loginDto, password: 'CorrectPassword123!' },
        '127.0.0.1',
      ) as Record<string, unknown>;

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).not.toHaveProperty('requires2FA');
    });

    it('should return tempToken when 2FA is enabled', async () => {
      const bcryptHash = require('bcrypt');
      const hashedPassword = await bcryptHash.hash('CorrectPassword123!', 12);

      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUser,
        password: hashedPassword,
        emailVerified: true,
        avatarUrl: null,
        bio: null,
        accountType: 'PERSONAL',
        isKahadePlus: false,
        subscriptionExpiresAt: null,
        membershipRank: 'BASIC',
        phoneNumber: null,
        phoneVerified: false,
        dateOfBirth: null,
        gender: null,
        createdAt: new Date(),
        lastLoginAt: null,
        lastLoginIp: null,
      });
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue({ isEnabled: true });
      mockTokenService.signTempToken.mockReturnValue('temp-token-xyz');

      const result = await service.login(
        { ...loginDto, password: 'CorrectPassword123!' },
        '127.0.0.1',
      ) as Record<string, unknown>;

      expect(result).toHaveProperty('requires2FA', true);
      expect(result).toHaveProperty('tempToken', 'temp-token-xyz');
    });
  });

  describe('refresh token owner binding', () => {
    it('rejects a refresh token when its JTI session belongs to another user', async () => {
      mockTokenService.verifyRefreshToken.mockReturnValue({ sub: 'db-id-1', jti: 'refresh-jti-1' });
      mockPrisma.userSession.findUnique.mockResolvedValue({
        id: 'session-other-user',
        userId: 'db-id-2',
        isRevoked: false,
        expiresAt: new Date(Date.now() + 60_000),
        refreshToken: 'stored-hash',
      });

      await expect(service.refreshToken('refresh-token')).rejects.toThrow(UnauthorizedException);
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
    });

    it('notifies the account after refresh-token reuse revokes every active session', async () => {
      const { sha256 } = require('../../../common/utils/crypto.util');
      mockTokenService.verifyRefreshToken.mockReturnValue({ sub: 'db-id-1', jti: 'refresh-jti-1' });
      mockPrisma.userSession.findUnique.mockResolvedValue({
        id: 'session-current',
        userId: 'db-id-1',
        isRevoked: false,
        expiresAt: new Date(Date.now() + 60_000),
        refreshToken: await bcryptHash(sha256('other-refresh-token'), 4),
      });
      mockPrisma.userSession.findMany.mockResolvedValue([{ id: 'session-current' }, { id: 'session-other' }]);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 2 });
      mockPrisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
      mockPrisma.$transaction.mockImplementation(async (callback: (client: typeof mockPrisma) => unknown) => callback(mockPrisma));

      await expect(service.refreshToken('refresh-token')).rejects.toThrow(UnauthorizedException);
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { userId: 'db-id-1', isRevoked: false },
        data: expect.objectContaining({ revokedReason: 'token_reuse_detected' }),
      }));
      expect(mockPrisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ title: 'Refresh Token Reuse Detected' }),
      }));
      expect(mockEmailQueue.add).toHaveBeenCalledWith('send', expect.objectContaining({
        subject: 'Security Alert: Session Credential Reuse Detected',
      }), expect.any(Object));
    });
  });

  describe('phoneRegister temp token', () => {
    it('rejects a registration temp token without a JTI claim', async () => {
      mockTokenService.verifyTempToken.mockReturnValue({
        sub: '+628123456789',
        scope: 'phone_register',
      });

      await expect(service.phoneRegister({
        tempToken: 'temp-token',
        fullName: 'Test User',
        username: 'test-user',
        dateOfBirth: '2000-01-01',
        gender: 'OTHER',
        email: 'new@example.com',
        password: 'Strong!123',
        pin: '135790',
      }, 'device-1', 'test-device', '127.0.0.1')).rejects.toThrow('Invalid registration token');
      expect(mockRedis.setNx).not.toHaveBeenCalled();
    });
  });

  // ─── forgotPassword ──────────────────────────────────────────────

  describe('forgotPassword', () => {
    it('should always return ambiguous message to prevent user enumeration (user exists)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser, isActive: true });
      mockOtpService.invalidateOtps.mockResolvedValue(undefined);
      mockOtpService.generateOtp.mockResolvedValue('111111');
      mockEmailQueue.add.mockResolvedValue({ id: 'job-1' });

      const result = await service.forgotPassword('user@example.com');

      expect(result.message).toContain('If this email');
    });

    it('sends email verification as a manual OTP without placing the secret in a URL', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockPrisma.$transaction.mockImplementation(async (callback: (client: typeof mockPrisma) => unknown) => callback(mockPrisma));
      mockPrisma.user.create.mockResolvedValue({ id: 'user-new', userId: 'usr-new', email: 'new@example.com' });
      mockOtpService.invalidateOtps.mockResolvedValue(undefined);
      mockOtpService.generateOtp.mockResolvedValue('123456');
      mockEmailQueue.add.mockResolvedValue({ id: 'job-1' });

      await service.register({
        fullName: 'New User', email: 'new@example.com', password: 'Password123!@', confirmPassword: 'Password123!@',
      }, '127.0.0.1');

      expect(mockEmailQueue.add).toHaveBeenCalledWith('send', expect.objectContaining({
        templateName: 'verify-email',
        templateContext: { otp: '123456' },
      }), expect.any(Object));
      expect(JSON.stringify(mockEmailQueue.add.mock.calls)).not.toContain('verifyUrl');
    });

    it('should always return ambiguous message to prevent user enumeration (user does not exist)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const result = await service.forgotPassword('nonexistent@example.com');

      expect(result.message).toContain('If this email');
      expect(mockOtpService.generateOtp).not.toHaveBeenCalled();
    });

    it('does not write the requested email address to logs when recovery delivery fails', async () => {
      const email = 'sensitive-recovery@example.com';
      const loggerWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser, email, isActive: true, isBanned: false });
      mockOtpService.invalidateOtps.mockRejectedValue(new Error('provider unavailable'));

      await expect(service.forgotPassword(email)).resolves.toEqual(expect.objectContaining({ message: expect.any(String) }));

      expect(loggerWarn.mock.calls.flat().join(' ')).not.toContain(email);
      loggerWarn.mockRestore();
    });
  });

  describe('resetPassword', () => {
    it('does not consume a valid reset OTP when the proposed password is the current password', async () => {
      const existingPassword = 'ExistingPassword123!@';
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUser,
        password: await bcryptHash(existingPassword, 4),
      });
      mockPrisma.passwordHistory.findMany.mockResolvedValue([]);

      await expect(service.resetPassword(
        'user@example.com',
        '123456',
        existingPassword,
        existingPassword,
      )).rejects.toThrow(BadRequestException);

      expect(mockOtpService.verifyOtp).not.toHaveBeenCalled();
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
    });

    it('revokes trusted devices after a successful password reset', async () => {
      const currentPassword = 'ExistingPassword123!@';
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUser,
        password: await bcryptHash(currentPassword, 4),
      });
      mockPrisma.passwordHistory.findMany.mockResolvedValue([]);
      mockOtpService.verifyOtp.mockResolvedValue(true);
      mockPrisma.userSession.findMany.mockResolvedValue([{ id: 'reset-session-1' }]);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userDevice.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.$transaction.mockImplementation(async (callback: (client: typeof mockPrisma) => unknown) => callback(mockPrisma));

      await expect(service.resetPassword(
        'user@example.com',
        '123456',
        'NewPassword123!@',
        'NewPassword123!@',
      )).resolves.toEqual(expect.objectContaining({ message: expect.any(String) }));

      expect(mockPrisma.userDevice.updateMany).toHaveBeenCalledWith({
        where: { userId: mockUser.id, isTrusted: true },
        data: { isTrusted: false, trustedAt: null },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockPrisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ title: 'Password Reset' }),
      }));
    });

    it('completes durable reset and trust revocation when Redis propagation fails', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUser,
        password: await bcryptHash('ExistingPassword123!@', 4),
      });
      mockPrisma.passwordHistory.findMany.mockResolvedValue([]);
      mockOtpService.verifyOtp.mockResolvedValue(true);
      mockPrisma.userSession.findMany.mockResolvedValue([{ id: 'reset-session-1' }]);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userDevice.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.$transaction.mockImplementation(async (callback: (client: typeof mockPrisma) => unknown) => callback(mockPrisma));
      mockRedis.setex.mockRejectedValue(new Error('redis unavailable'));

      await expect(service.resetPassword('user@example.com', '123456', 'NewPassword123!@', 'NewPassword123!@'))
        .resolves.toEqual(expect.objectContaining({ message: expect.any(String) }));
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ isRevoked: true, revokedReason: 'password_reset' }),
      }));
      expect(mockPrisma.userDevice.updateMany).toHaveBeenCalledWith({
        where: { userId: mockUser.id, isTrusted: true },
        data: { isTrusted: false, trustedAt: null },
      });
    });
  });

  describe('backup code regeneration', () => {
    const authenticatorSecret = 'JBSWY3DPEHPK3PXP';

    beforeEach(async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser });
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue({
        id: 'two-factor-1',
        userId: mockUser.id,
        isEnabled: true,
        secret: await encryptAES(authenticatorSecret),
        backupCodes: [],
        usedBackupCodes: [],
      });
      mockPrisma.twoFactorAuth.update.mockResolvedValue({});
      mockRedis.incr.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1);
      mockRedis.setNx.mockResolvedValue(true);
      mockRedis.releaseLock.mockResolvedValue(true);
      mockRedis.getClient.mockReturnValue({
        sadd: jest.fn().mockResolvedValue(1),
        expire: jest.fn().mockResolvedValue(1),
      });
    });

    it('requires an authenticator code in addition to the account password', async () => {
      await expect(service.regenerateBackupCodes(mockUser.id, 'password', 'invalid')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.twoFactorAuth.update).not.toHaveBeenCalled();
    });

    it('rejects an invalid authenticator code without replacing current backup codes', async () => {
      jest.spyOn(speakeasy.totp, 'verify').mockReturnValue(false);

      await expect(service.regenerateBackupCodes(mockUser.id, 'password', '123456')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.twoFactorAuth.update).not.toHaveBeenCalled();
      expect(mockRedis.releaseLock).toHaveBeenCalled();
    });

    it('rejects reuse of an authenticator code before replacing recovery codes', async () => {
      jest.spyOn(speakeasy.totp, 'verify').mockReturnValue(true);
      mockRedis.getClient.mockReturnValue({
        sadd: jest.fn().mockResolvedValue(0),
        expire: jest.fn().mockResolvedValue(1),
      });

      await expect(service.regenerateBackupCodes(mockUser.id, 'password', '123456')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.twoFactorAuth.update).not.toHaveBeenCalled();
    });

    it('replaces all recovery codes only after valid password and unused authenticator factors', async () => {
      jest.spyOn(speakeasy.totp, 'verify').mockReturnValue(true);
      const validPassword = 'Correct!Password123';
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUser,
        password: await bcryptHash(validPassword, 4),
      });

      const result = await service.regenerateBackupCodes(mockUser.id, validPassword, '123456');

      expect(result.backupCodes).toHaveLength(10);
      expect(result.backupCodes.every((code) => /^[A-Z0-9]{16}$/.test(code))).toBe(true);
      expect(mockPrisma.twoFactorAuth.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { userId: mockUser.id },
        data: expect.objectContaining({ usedBackupCodes: [] }),
      }));
      expect(mockRedis.releaseLock).toHaveBeenCalled();
    });

    it('rejects a concurrent regeneration instead of allowing returned codes to be overwritten', async () => {
      mockRedis.setNx.mockResolvedValue(false);

      await expect(service.regenerateBackupCodes(mockUser.id, 'password', '123456')).rejects.toBeInstanceOf(ConflictException);
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.twoFactorAuth.update).not.toHaveBeenCalled();
    });
  });

  describe('2FA disable with recovery code', () => {
    it('accepts a backup code only after the email OTP factor succeeds and revokes all sessions', async () => {
      const validPassword = 'Correct!Password123';
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUser,
        password: await bcryptHash(validPassword, 4),
      });
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue({
        id: 'two-factor-1',
        userId: mockUser.id,
        isEnabled: true,
        secret: await encryptAES('JBSWY3DPEHPK3PXP'),
        backupCodes: ['hash'],
        usedBackupCodes: [],
      });
      mockOtpService.verifyOtp.mockResolvedValue(true);
      mockPrisma.twoFactorAuth.update.mockResolvedValue({});
      mockPrisma.userSession.findMany.mockResolvedValue([{ id: 'session-1' }]);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userDevice.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
      );
      const consumeBackupCode = jest.spyOn(service as unknown as { checkAndConsumeBackupCode: (twoFactor: unknown, code: string) => Promise<boolean> }, 'checkAndConsumeBackupCode').mockResolvedValue(true);

      const result = await service.disable2fa(mockUser.id, validPassword, 'A1B2C3D4E5F6G7H8', '123456');

      expect(mockOtpService.verifyOtp).toHaveBeenCalledWith(mockUser.email, OtpType.TWO_FA_DISABLE, '123456');
      expect(consumeBackupCode).toHaveBeenCalledWith(expect.objectContaining({ id: 'two-factor-1' }), 'A1B2C3D4E5F6G7H8');
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { userId: mockUser.id, isRevoked: false },
      }));
      expect(mockPrisma.userDevice.updateMany).toHaveBeenCalledWith({
        where: { userId: mockUser.id, isTrusted: true },
        data: { isTrusted: false, trustedAt: null },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockPrisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ title: 'Two-Factor Authentication Disabled' }),
      }));
      expect(result.message).toContain('sessions have been revoked');
    });
  });

  // ─── logout ──────────────────────────────────────────────────────

  describe('logout', () => {
    it('should blacklist the access token JTI in Redis', async () => {
      mockRedis.setex.mockResolvedValue('OK');
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockTokenService.getAccessTokenTtlSeconds.mockReturnValue(900);

      await service.logout('user-1', 'session-1', 'jti-abc123', false);

      expect(mockRedis.setex).toHaveBeenCalledWith(
        expect.stringContaining('jti-abc123'),
        900,
        '1',
        expect.anything(),
      );
    });

    it('should revoke only current session when logoutAll is false', async () => {
      mockRedis.setex.mockResolvedValue('OK');
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockTokenService.getAccessTokenTtlSeconds.mockReturnValue(900);

      await service.logout('user-1', 'session-1', 'jti-abc123', false);

      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'session-1', userId: 'user-1' }),
        }),
      );
    });

    it('durably revokes the current session even if Redis blacklist propagation fails', async () => {
      mockRedis.setex.mockRejectedValue(new Error('redis unavailable'));
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.logout('user-1', 'session-1', 'jti-abc123', false))
        .resolves.toEqual({ message: 'Logout successful' });
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'session-1', userId: 'user-1', isRevoked: false }),
        data: expect.objectContaining({ isRevoked: true, revokedReason: 'logout' }),
      }));
    });

    it('should revoke all sessions when logoutAll is true', async () => {
      mockRedis.setex.mockResolvedValue('OK');
      mockPrisma.userSession.findMany.mockResolvedValue([{ id: 'session-1' }, { id: 'session-2' }]);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 2 });
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
      );

      await service.logout('user-1', 'session-1', 'jti-abc123', true);

      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1', isRevoked: false }),
        }),
      );
    });

    it('should return success message', async () => {
      mockRedis.setex.mockResolvedValue('OK');
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockTokenService.getAccessTokenTtlSeconds.mockReturnValue(900);

      const result = await service.logout('user-1', 'session-1', 'jti-abc123', false);

      expect(result).toEqual({ message: 'Logout successful' });
    });
  });

  // ─── verifyEmail ──────────────────────────────────────────────────

  describe('verifyEmail', () => {
    it('should throw BadRequestException when no matching OTP record exists', async () => {
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
      );
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', isActive: true, isBanned: false });
      mockPrisma.otpCode.findFirst.mockResolvedValue(null);

      await expect(
        service.verifyEmail('user@example.com', 'wrong-otp'),
      ).rejects.toThrow(BadRequestException);
    });

    it('does not inspect or consume an email OTP for an inactive account', async () => {
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
      );
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', isActive: false, isBanned: false });

      await expect(service.verifyEmail('user@example.com', '123456')).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.otpCode.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.otpCode.updateMany).not.toHaveBeenCalled();
    });
  });

  // ─── setUsername ──────────────────────────────────────────────────

  describe('setUsername', () => {
    it('should throw BadRequestException for reserved username', async () => {
      await expect(
        service.setUsername('user-1', 'admin'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should set username when not already set', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser, username: null });
      mockPrisma.user.update.mockResolvedValue({ ...mockUser, username: 'johndoe' });
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue(null);

      const result = await service.setUsername('user-1', 'johndoe') as { user: Record<string, unknown> };

      expect(result).toHaveProperty('user');
      expect(result.user).toHaveProperty('username', 'johndoe');
    });

    it('should throw BadRequestException when username already set', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUser,
        username: 'existingname',
        id: 'user-1',
      });

      await expect(
        service.setUsername('user-1', 'newname'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
