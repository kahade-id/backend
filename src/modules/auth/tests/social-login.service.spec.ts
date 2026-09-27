import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';
import { AuthService } from '../auth.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { TokenService } from '../token.service';
import { OtpService } from '../otp.service';
import { OtpGatewayService } from '../otp-gateway.service';
import { OtpTriggerService } from '../otp-trigger.service';
import { AuthLocationService } from '../auth-location.service';
import { AppleAuthService } from '../apple-auth.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { EMAIL_QUEUE } from '../../queue/processors/email.processor';
import { initializeCrypto } from '../../../common/utils/crypto.util';

// generateSyntheticPhone memakai hashPhoneNumber (HMAC) + encryptPii (AES) —
// inisialisasi crypto dengan kunci dummy untuk test.
initializeCrypto({
  aesSecretKey: 'test-aes-secret-key-32-chars-minimum!',
  hmacSecretKey: 'test-hmac-secret-key-32-chars-min!!',
});

/**
 * GAP-A (G025): uji login sosial — Google/Apple, konflik email (G014),
 * tautan/putus tautan + guard metode terakhir (G019), 2FA (G016),
 * nomor sintetis + requiresPhoneVerification (G015).
 */
describe('AuthService.socialLogin (GAP-A G001–G025)', () => {
  let service: AuthService;

  const mockPrisma: any = {
    socialAccount: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn(), delete: jest.fn(), findMany: jest.fn() },
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    wallet: { create: jest.fn() },
    notificationPreference: { create: jest.fn() },
    referralCode: { create: jest.fn() },
    twoFactorAuth: { findUnique: jest.fn() },
    userSession: {
      create: jest.fn().mockResolvedValue({ id: 'sess-1' }),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    userDevice: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    notification: { create: jest.fn().mockResolvedValue({}) },
    passkeyCredential: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn(),
    emitNotificationCreated: jest.fn(),
  };
  const mockTokenService = {
    signTempToken: jest.fn().mockReturnValue('link-token-abc'),
    verifyTempToken: jest.fn(),
    signRefreshToken: jest.fn().mockReturnValue('refresh-xyz'),
    signAccessToken: jest.fn().mockReturnValue('access-xyz'),
    decodeToken: jest.fn().mockReturnValue({ jti: 'jti-refresh-1' }),
  };
  const mockAppleAuth = {
    isConfigured: jest.fn().mockReturnValue(true),
    getClientId: jest.fn().mockReturnValue('apple-client-id-test'),
    verifyIdentityToken: jest.fn(),
  };
  const mockConfig = {
    get: jest.fn((key: string) => {
      if (key === 'app.googleClientId') return 'google-client-id-test';
      return undefined;
    }),
  };
  const mockAuditLog = { logUserAction: jest.fn() };

  const baseUser = {
    id: 'db-user-1',
    userId: 'usr_test1',
    username: null,
    email: 'user@example.com',
    fullName: 'Test User',
    avatarUrl: null,
    bio: null,
    accountType: 'PERSONAL',
    emailVerified: true,
    kycStatus: 'PENDING',
    isKahadePlus: false,
    subscriptionExpiresAt: null,
    membershipRank: 'BASIC',
    phoneNumber: 'enc-phone',
    phoneVerified: true,
    dateOfBirth: null,
    gender: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    isActive: true,
    isBanned: false,
    lockedUntil: null,
    password: null,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: $transaction menjalankan callback dengan mockPrisma sebagai tx.
    mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockPrisma));
    mockConfig.get.mockImplementation((key: string) => {
      if (key === 'app.googleClientId') return 'google-client-id-test';
      return undefined;
    });
    mockAppleAuth.isConfigured.mockReturnValue(true);
    mockAppleAuth.getClientId.mockReturnValue('apple-client-id-test');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: { setNx: jest.fn().mockResolvedValue(true), setex: jest.fn(), get: jest.fn(), releaseLock: jest.fn() } },
        { provide: TokenService, useValue: mockTokenService },
        { provide: OtpService, useValue: {} },
        { provide: OtpGatewayService, useValue: {} },
        { provide: ConfigService, useValue: mockConfig },
        { provide: AuditLogService, useValue: mockAuditLog },
        { provide: RealtimeService, useValue: {} },
        { provide: AuthLocationService, useValue: { logEvent: jest.fn() } },
        { provide: OtpTriggerService, useValue: {} },
        { provide: AppleAuthService, useValue: mockAppleAuth },
        { provide: getQueueToken(EMAIL_QUEUE), useValue: { add: jest.fn() } },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
  });

  describe('getSocialProviders (G003)', () => {
    it('melaporkan kapabilitas dari konfigurasi server (G002/G003)', () => {
      expect(service.getSocialProviders()).toEqual({
        providers: [
          { provider: 'GOOGLE', enabled: true, appId: 'google-client-id-test' },
          { provider: 'APPLE', enabled: true, appId: 'apple-client-id-test' },
        ],
      });
    });

    it('google disabled tanpa appId bila client id tidak dikonfigurasi (G005)', () => {
      mockConfig.get.mockReturnValue(undefined);
      mockAppleAuth.getClientId.mockReturnValue(null);
      mockAppleAuth.isConfigured.mockReturnValue(false);
      expect(service.getSocialProviders()).toEqual({
        providers: [
          { provider: 'GOOGLE', enabled: false, appId: null },
          { provider: 'APPLE', enabled: false, appId: null },
        ],
      });
    });
  });

  describe('login tertaut (G012)', () => {
    it('login langsung bila (provider, sub) sudah tertaut', async () => {
      mockPrisma.socialAccount.findUnique.mockResolvedValue({
        id: 'sa-1',
        user: { ...baseUser },
      });
      mockPrisma.socialAccount.update.mockResolvedValue({});
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue(null);
      mockPrisma.user.update.mockResolvedValue({});

      const result: any = await (service as any).loginWithSocialIdentity(
        'GOOGLE',
        { sub: 'google-sub-1', email: 'user@example.com', emailVerified: true, name: 'Test' },
        'dev-1',
        'test-agent',
        '127.0.0.1',
      );

      expect(result.accessToken).toBe('access-xyz');
      expect(result.isNewUser).toBe(false);
      expect(mockPrisma.socialAccount.update).toHaveBeenCalledWith({
        where: { id: 'sa-1' },
        data: { lastUsedAt: expect.any(Date) },
      });
    });

    it('melempar TWO_FA_REQUIRED bila 2FA aktif (G016)', async () => {
      mockPrisma.socialAccount.findUnique.mockResolvedValue({ id: 'sa-1', user: { ...baseUser } });
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue({ isEnabled: true });

      await expect(
        (service as any).loginWithSocialIdentity(
          'GOOGLE',
          { sub: 'google-sub-1', email: 'user@example.com', emailVerified: true },
          'dev-1',
          'test-agent',
          '127.0.0.1',
        ),
      ).rejects.toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'TWO_FA_REQUIRED' }) }));
    });
  });

  describe('konflik email (G014)', () => {
    it('TIDAK auto-link/auto-create — mengembalikan requiresLink + linkToken', async () => {
      mockPrisma.socialAccount.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({ ...baseUser });

      const result: any = await (service as any).loginWithSocialIdentity(
        'GOOGLE',
        { sub: 'google-sub-2', email: 'user@example.com', emailVerified: true },
        'dev-1',
        'test-agent',
        '127.0.0.1',
      );

      expect(result.requiresLink).toBe(true);
      expect(result.linkToken).toBe('link-token-abc');
      expect(result.provider).toBe('google');
      // Email di-masking, bukan mentah (G014).
      expect(result.maskedEmail).toBe('u••••••@example.com');
      expect(mockTokenService.signTempToken).toHaveBeenCalledWith(
        expect.objectContaining({
          // Anti take-over: token TIDAK membawa user id (sub='pending').
          sub: 'pending',
          scope: 'social_link_confirm',
          extra: expect.objectContaining({ provider: 'GOOGLE', providerSub: 'google-sub-2' }),
        }),
      );
      // Tidak ada user baru yang dibuat.
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('identitas baru → signup token, TANPA pembuatan akun diam-diam', () => {
    it('mengembalikan requiresLink + isNewIdentity; user TIDAK dibuat', async () => {
      mockPrisma.socialAccount.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue(null); // email belum dipakai

      const result: any = await (service as any).loginWithSocialIdentity(
        'APPLE',
        { sub: 'apple-sub-9', email: 'new@example.com', emailVerified: true },
        'dev-1',
        'test-agent',
        '127.0.0.1',
      );

      // Keputusan produk: registrasi tetap nomor HP + OTP WhatsApp.
      expect(result.requiresLink).toBe(true);
      expect(result.isNewIdentity).toBe(true);
      expect(result.linkToken).toBe('link-token-abc');
      expect(mockTokenService.signTempToken).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'pending',
          scope: 'social_signup',
          extra: expect.objectContaining({ provider: 'APPLE', providerSub: 'apple-sub-9' }),
        }),
      );
      // Tidak ada user yang dibuat diam-diam.
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockAuditLog.logUserAction).not.toHaveBeenCalled();
    });
  });

  describe('confirmSocialLink (G014) — re-auth akun lama WAJIB', () => {
    beforeEach(() => {
      jest.spyOn(service as any, 'assertPasskeyReauthenticated').mockResolvedValue(undefined);
      jest.spyOn(service as any, 'claimTempTokenOnce').mockResolvedValue(undefined);
    });

    it('menolak token dengan scope salah', async () => {
      mockTokenService.verifyTempToken.mockReturnValue({
        sub: 'pending',
        scope: '2fa_verify',
        jti: 'jti-1',
      });
      await expect(
        service.confirmSocialLink('tok', { password: 'x' }, 'dev-1', 'agent', '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('menautkan lalu login setelah re-auth lolos', async () => {
      mockTokenService.verifyTempToken.mockReturnValue({
        sub: 'pending',
        scope: 'social_link_confirm',
        jti: 'jti-2',
        exp: Math.floor(Date.now() / 1000) + 300,
        provider: 'GOOGLE',
        providerSub: 'google-sub-2',
        email: 'user@example.com',
      });
      mockPrisma.socialAccount.findUnique.mockResolvedValue(null); // belum tertaut
      mockPrisma.user.findUnique.mockResolvedValue({ ...baseUser });
      mockPrisma.socialAccount.create.mockResolvedValue({ id: 'sa-new' });
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue(null);
      mockPrisma.user.update.mockResolvedValue({});

      const result = await service.confirmSocialLink(
        'tok',
        { password: 'secret123' },
        'dev-1',
        'agent',
        '127.0.0.1',
      );
      // Re-auth diverifikasi terhadap akun pemilik email.
      expect(service['assertPasskeyReauthenticated']).toHaveBeenCalledWith(
        'db-user-1',
        { password: 'secret123' },
      );
      expect(result.accessToken).toBe('access-xyz');
      expect(mockPrisma.socialAccount.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'db-user-1',
          provider: 'GOOGLE',
          providerSub: 'google-sub-2',
          consentTextVersion: AuthService.SOCIAL_CONSENT_VERSION,
        }),
      });
    });

    it('MENOLAK bila re-auth gagal — anti account-takeover', async () => {
      mockTokenService.verifyTempToken.mockReturnValue({
        sub: 'pending',
        scope: 'social_link_confirm',
        jti: 'jti-2b',
        exp: Math.floor(Date.now() / 1000) + 300,
        provider: 'GOOGLE',
        providerSub: 'google-sub-2',
        email: 'user@example.com',
      });
      mockPrisma.user.findUnique.mockResolvedValue({ ...baseUser });
      (service['assertPasskeyReauthenticated'] as jest.Mock).mockRejectedValueOnce(
        new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Kata sandi salah.' }),
      );

      await expect(
        service.confirmSocialLink('tok', { password: 'salah' }, 'dev-1', 'agent', '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException);
      // Tidak ada penautan, tidak ada sesi.
      expect(mockPrisma.socialAccount.create).not.toHaveBeenCalled();
      expect(mockTokenService.signAccessToken).not.toHaveBeenCalled();
    });

    it('menolak bila providerSub sudah tertaut ke akun LAIN (G014)', async () => {
      mockTokenService.verifyTempToken.mockReturnValue({
        sub: 'pending',
        scope: 'social_link_confirm',
        jti: 'jti-3',
        exp: Math.floor(Date.now() / 1000) + 300,
        provider: 'GOOGLE',
        providerSub: 'google-sub-x',
        email: 'user@example.com',
      });
      mockPrisma.user.findUnique.mockResolvedValue({ ...baseUser });
      mockPrisma.socialAccount.findUnique.mockResolvedValue({ id: 'sa-x', userId: 'db-other' });

      await expect(
        service.confirmSocialLink('tok', { password: 'secret123' }, 'dev-1', 'agent', '127.0.0.1'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('unlinkSocialProvider (G019)', () => {
    const reauth = { password: 'secret123' };

    beforeEach(() => {
      // re-auth sukses: user punya password yang cocok
      jest.spyOn(service as any, 'assertPasskeyReauthenticated').mockResolvedValue(undefined);
    });

    it('menolak bila ini satu-satunya metode login (G019)', async () => {
      mockPrisma.socialAccount.findFirst.mockResolvedValue({ id: 'sa-1' });
      mockPrisma.user.findUnique.mockResolvedValue({ password: null });
      mockPrisma.socialAccount.count.mockResolvedValue(0);
      mockPrisma.passkeyCredential.count.mockResolvedValue(0);

      await expect(
        service.unlinkSocialProvider('db-user-1', 'google', reauth, '127.0.0.1'),
      ).rejects.toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'SOCIAL_LAST_METHOD' }) }));
      expect(mockPrisma.socialAccount.delete).not.toHaveBeenCalled();
    });

    it('berhasil bila masih ada password', async () => {
      mockPrisma.socialAccount.findFirst.mockResolvedValue({ id: 'sa-1' });
      mockPrisma.user.findUnique.mockResolvedValue({ password: 'hashed' });
      mockPrisma.socialAccount.count.mockResolvedValue(0);
      mockPrisma.passkeyCredential.count.mockResolvedValue(0);
      mockPrisma.socialAccount.delete.mockResolvedValue({});
      mockPrisma.socialAccount.findMany.mockResolvedValue([]);

      const result = await service.unlinkSocialProvider('db-user-1', 'google', reauth, '127.0.0.1');
      expect(mockPrisma.socialAccount.delete).toHaveBeenCalledWith({ where: { id: 'sa-1' } });
      expect(result.message).toContain('dilepas');
    });

    it('berhasil bila nomor HP terverifikasi (login OTP WhatsApp tersedia)', async () => {
      mockPrisma.socialAccount.findFirst.mockResolvedValue({ id: 'sa-1' });
      // Tanpa password, tanpa social lain, tanpa passkey — TAPI phoneVerified.
      mockPrisma.user.findUnique.mockResolvedValue({ password: null, phoneVerified: true });
      mockPrisma.socialAccount.count.mockResolvedValue(0);
      mockPrisma.passkeyCredential.count.mockResolvedValue(0);
      mockPrisma.socialAccount.delete.mockResolvedValue({});
      mockPrisma.socialAccount.findMany.mockResolvedValue([]);

      const result = await service.unlinkSocialProvider('db-user-1', 'google', reauth, '127.0.0.1');
      expect(mockPrisma.socialAccount.delete).toHaveBeenCalledWith({ where: { id: 'sa-1' } });
      expect(result.message).toContain('dilepas');
    });

    it('404 bila provider belum tertaut', async () => {
      mockPrisma.socialAccount.findFirst.mockResolvedValue(null);
      await expect(
        service.unlinkSocialProvider('db-user-1', 'apple', reauth, '127.0.0.1'),
      ).rejects.toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'SOCIAL_PROVIDER_NOT_LINKED' }) }));
    });
  });

  describe('socialLogin entrypoint', () => {
    it('apple tanpa konfigurasi → SOCIAL_PROVIDER_NOT_SUPPORTED (G002/G005)', async () => {
      mockAppleAuth.isConfigured.mockReturnValue(false);
      await expect(
        service.socialLogin('apple', 'tok', 'dev-1', 'agent', '127.0.0.1', 'nonce-1'),
      ).rejects.toThrow(
        expect.objectContaining({ response: expect.objectContaining({ code: 'SOCIAL_PROVIDER_NOT_SUPPORTED' }) }),
      );
      expect(mockAppleAuth.verifyIdentityToken).not.toHaveBeenCalled();
    });

    it('meneruskan nonce ke verifikasi Apple (G011)', async () => {
      mockAppleAuth.verifyIdentityToken.mockResolvedValue({ sub: 'apple-sub-1', email: 'a@x.id', emailVerified: true });
      mockPrisma.socialAccount.findUnique.mockResolvedValue({ id: 'sa-1', user: { ...baseUser } });
      mockPrisma.socialAccount.update.mockResolvedValue({});
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue(null);
      mockPrisma.user.update.mockResolvedValue({});

      await service.socialLogin('apple', 'id-token', 'dev-1', 'agent', '127.0.0.1', 'nonce-xyz');
      expect(mockAppleAuth.verifyIdentityToken).toHaveBeenCalledWith('id-token', 'nonce-xyz');
    });
  });

  describe('assertRealPhoneForSensitive (G015)', () => {
    it('menolak aksi sensitif bila nomor masih sintetis', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ requiresPhoneVerification: true });
      await expect(service.assertRealPhoneForSensitive('db-user-1')).rejects.toThrow(
        expect.objectContaining({ response: expect.objectContaining({ code: 'PHONE_VERIFICATION_REQUIRED' }) }),
      );
    });

    it('lolos bila nomor sudah terverifikasi', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ requiresPhoneVerification: false });
      await expect(service.assertRealPhoneForSensitive('db-user-1')).resolves.toBeUndefined();
    });
  });
});
