/**
 * Unit test PasskeyService (G049).
 *
 * Strategi: @simplewebauthn/server di-mock — yang diuji adalah LOGIKA
 * verifikasi milik kita (bukan kriptografi library):
 *  - signature valid / invalid
 *  - origin salah / RP ID salah (library menolak → 400 + audit)
 *  - challenge kedaluwarsa & dipakai ulang / replay (anti-replay)
 *  - anomali counter (G046) vs pasangan 0/0 passkey sync yang diizinkan
 *  - revoke kredensial terakhir tanpa metode lain ditolak (G038)
 */
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { PasskeyService } from '../passkey.service';

jest.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: jest.fn(),
  verifyRegistrationResponse: jest.fn(),
  generateAuthenticationOptions: jest.fn(),
  verifyAuthenticationResponse: jest.fn(),
}));

import {
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const mockVerifyRegistration = verifyRegistrationResponse as jest.Mock;
const mockVerifyAuthentication = verifyAuthenticationResponse as jest.Mock;

function makePrisma() {
  return {
    passkeyCredential: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    user: { findUnique: jest.fn(), findFirst: jest.fn() },
    userDevice: { findFirst: jest.fn() },
    notification: { create: jest.fn().mockResolvedValue({}) },
    emitNotificationCreated: jest.fn(),
  };
}

function makeRedis() {
  return {
    setNx: jest.fn().mockResolvedValue(true),
    getAndDelete: jest.fn(),
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'webauthn.rpId': 'localhost',
    'webauthn.rpName': 'Kahade',
    'webauthn.origins': ['http://localhost:8081'],
    'webauthn.challengeTtlSeconds': 300,
    'webauthn.maxPerUser': 10,
    'webauthn.requiredFor': ['bank_account_change', 'security_change'],
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key] ?? undefined) };
}

function makeService(deps: {
  prisma?: ReturnType<typeof makePrisma>;
  redis?: ReturnType<typeof makeRedis>;
  config?: ReturnType<typeof makeConfig>;
} = {}) {
  const prisma = deps.prisma ?? makePrisma();
  const redis = deps.redis ?? makeRedis();
  const config = deps.config ?? makeConfig();
  const tokenService = { signTempToken: jest.fn(), verifyTempToken: jest.fn() };
  const otpService = {
    generatePhoneOtp: jest.fn(),
    verifyPhoneOtp: jest.fn(),
    invalidatePhoneOtps: jest.fn(),
  };
  const otpGateway = { supportsMethod: jest.fn().mockReturnValue(true), sendOtp: jest.fn() };
  const authService = {
    assertPasskeyReauthenticated: jest.fn().mockResolvedValue(undefined),
    loginWithPasskey: jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r' }),
  };
  const auditLog = { logUserAction: jest.fn() };
  const service = new PasskeyService(
    prisma as never,
    redis as never,
    config as never,
    tokenService as never,
    otpService as never,
    otpGateway as never,
    authService as never,
    auditLog as never,
  );
  return { service, prisma, redis, config, tokenService, otpService, otpGateway, authService, auditLog };
}

const storedChallenge = JSON.stringify({
  challenge: 'test-challenge-base64url',
  type: 'authentication',
  userId: null,
});

const baseCredential = {
  id: 'cred-row-1',
  userId: 'user-1',
  credentialId: 'credential-id-abc',
  publicKey: Buffer.from('fake-public-key-bytes').toString('base64url'),
  counter: BigInt(5),
  deviceName: 'Chrome di Laptop',
  revokedAt: null,
  user: { id: 'user-1', isActive: true, isBanned: false, lockedUntil: null, phoneVerified: true },
};

describe('PasskeyService.verifyAuthentication (G030/G031/G046)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.WEBAUTHN_ENABLED;
  });

  test('signature valid → counter diupdate & sesi diterbitkan', async () => {
    const { service, prisma, redis, authService, auditLog } = makeService();
    redis.getAndDelete.mockResolvedValue(storedChallenge);
    prisma.passkeyCredential.findUnique.mockResolvedValue(baseCredential);
    prisma.passkeyCredential.update.mockResolvedValue({});
    mockVerifyAuthentication.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 6, credentialID: 'credential-id-abc' },
    });

    const result = await service.verifyAuthentication(
      { challengeId: 'cid', assertion: { id: 'credential-id-abc' } },
      '127.0.0.1',
    );

    expect(result).toEqual({ accessToken: 'a', refreshToken: 'r' });
    expect(prisma.passkeyCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred-row-1' },
      data: { counter: BigInt(6), lastUsedAt: expect.any(Date) },
    });
    expect(authService.loginWithPasskey).toHaveBeenCalledWith('user-1', '127.0.0.1', expect.anything());
    expect(auditLog.logUserAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PASSKEY_USED' }),
    );
  });

  test('signature invalid (library menolak) → 401 + audit PASSKEY_FAILED', async () => {
    const { service, redis, auditLog, prisma } = makeService();
    redis.getAndDelete.mockResolvedValue(storedChallenge);
    prisma.passkeyCredential.findUnique.mockResolvedValue(baseCredential);
    mockVerifyAuthentication.mockRejectedValue(new Error('bad signature'));

    await expect(
      service.verifyAuthentication({ challengeId: 'cid', assertion: { id: 'credential-id-abc' } }, '127.0.0.1'),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PASSKEY_ASSERTION_INVALID' }) });
    expect(auditLog.logUserAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PASSKEY_FAILED' }),
    );
  });

  test('challenge kedaluwarsa → 400 PASSKEY_CHALLENGE_INVALID', async () => {
    const { service, redis } = makeService();
    redis.getAndDelete.mockResolvedValue(null);

    await expect(
      service.verifyAuthentication({ challengeId: 'cid', assertion: { id: 'x' } }, '127.0.0.1'),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PASSKEY_CHALLENGE_INVALID' }) });
    expect(mockVerifyAuthentication).not.toHaveBeenCalled();
  });

  test('challenge dipakai ulang (replay) → ditolak karena sudah dikonsumsi', async () => {
    const { service, prisma, redis } = makeService();
    // Pemakaian pertama berhasil…
    redis.getAndDelete.mockResolvedValueOnce(storedChallenge).mockResolvedValueOnce(null);
    prisma.passkeyCredential.findUnique.mockResolvedValue(baseCredential);
    mockVerifyAuthentication.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 6 },
    });
    await service.verifyAuthentication({ challengeId: 'cid', assertion: { id: 'credential-id-abc' } }, '1.1.1.1');
    // …pemakaian kedua dengan challengeId sama harus gagal (getAndDelete atomik).
    await expect(
      service.verifyAuthentication({ challengeId: 'cid', assertion: { id: 'credential-id-abc' } }, '1.1.1.1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test('anomali counter (new <= stored) → 401 PASSKEY_COUNTER_ANOMALY + notifikasi + counter TIDAK diupdate', async () => {
    const { service, prisma, redis, authService, auditLog } = makeService();
    redis.getAndDelete.mockResolvedValue(storedChallenge);
    prisma.passkeyCredential.findUnique.mockResolvedValue({ ...baseCredential, counter: BigInt(10) });
    mockVerifyAuthentication.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 10 },
    });

    const err = (await service
      .verifyAuthentication({ challengeId: 'cid', assertion: { id: 'credential-id-abc' } }, '127.0.0.1')
      .catch(e => e)) as { response?: { code?: string } };
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.response?.code).toBe('PASSKEY_COUNTER_ANOMALY');
    expect(prisma.passkeyCredential.update).not.toHaveBeenCalled();
    expect(authService.loginWithPasskey).not.toHaveBeenCalled();
    expect(prisma.notification.create).toHaveBeenCalled();
    expect(auditLog.logUserAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PASSKEY_FAILED', description: expect.stringContaining('Anomali counter') }),
    );
  });

  test('pasangan counter 0/0 (passkey sync) → diizinkan', async () => {
    const { service, prisma, redis, authService } = makeService();
    redis.getAndDelete.mockResolvedValue(storedChallenge);
    prisma.passkeyCredential.findUnique.mockResolvedValue({ ...baseCredential, counter: BigInt(0) });
    mockVerifyAuthentication.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 0 },
    });

    await service.verifyAuthentication({ challengeId: 'cid', assertion: { id: 'credential-id-abc' } }, '127.0.0.1');
    expect(authService.loginWithPasskey).toHaveBeenCalled();
  });
});

describe('PasskeyService.verifyRegistration (G028/G032)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.WEBAUTHN_ENABLED;
  });

  const regChallenge = JSON.stringify({ challenge: 'reg-challenge', type: 'registration', userId: 'user-1' });

  test('origin salah → 400 PASSKEY_ATTESTATION_INVALID + audit', async () => {
    const { service, redis, auditLog } = makeService();
    redis.getAndDelete.mockResolvedValue(regChallenge);
    mockVerifyRegistration.mockRejectedValue(new Error('origin not allowed'));

    await expect(
      service.verifyRegistration('user-1', { challengeId: 'cid', attestation: { id: 'x' } }, '127.0.0.1'),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PASSKEY_ATTESTATION_INVALID' }) });
    expect(auditLog.logUserAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PASSKEY_FAILED' }),
    );
  });

  test('RP ID salah → 400 (library menolak expectedRPID)', async () => {
    const { service, redis } = makeService();
    redis.getAndDelete.mockResolvedValue(regChallenge);
    mockVerifyRegistration.mockRejectedValue(new Error('rpId mismatch'));

    await expect(
      service.verifyRegistration('user-1', { challengeId: 'cid', attestation: { id: 'x' } }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Challenge tetap terkonsumsi (sekali pakai) walau verifikasi gagal.
    expect(redis.getAndDelete).toHaveBeenCalledTimes(1);
  });

  test('registrasi sukses → kredensial tersimpan + audit PASSKEY_REGISTERED + notifikasi', async () => {
    const { service, prisma, redis, auditLog } = makeService();
    redis.getAndDelete.mockResolvedValue(regChallenge);
    mockVerifyRegistration.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'new-cred-id',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
        },
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
      },
    });
    prisma.passkeyCredential.findUnique.mockResolvedValue(null);
    prisma.passkeyCredential.create.mockResolvedValue({
      id: 'row-1', deviceName: 'HP saya', deviceType: 'multiDevice',
      createdAt: new Date(), lastUsedAt: null,
    });

    const result = await service.verifyRegistration(
      'user-1',
      { challengeId: 'cid', attestation: { id: 'new-cred-id' }, deviceName: 'HP saya' },
      '127.0.0.1',
    );
    expect(result.deviceName).toBe('HP saya');
    expect(prisma.passkeyCredential.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-1', credentialId: 'new-cred-id', counter: BigInt(0) }),
      }),
    );
    expect(auditLog.logUserAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PASSKEY_REGISTERED' }),
    );
    expect(prisma.notification.create).toHaveBeenCalled();
  });
});

describe('PasskeyService.revokeCredential (G037/G038)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('kredensial terakhir tanpa metode login lain → ditolak', async () => {
    const { service, prisma } = makeService();
    prisma.passkeyCredential.findFirst.mockResolvedValue({ id: 'cred-1', deviceName: 'Laptop' });
    prisma.user.findUnique.mockResolvedValue({ password: null });
    prisma.passkeyCredential.count.mockResolvedValue(0);

    await expect(
      service.revokeCredential('user-1', 'cred-1', {}, '127.0.0.1'),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PASSKEY_LAST_CREDENTIAL' }) });
    expect(prisma.passkeyCredential.update).not.toHaveBeenCalled();
  });

  test('ada password → revoke boleh (soft: revokedAt diset)', async () => {
    const { service, prisma, auditLog } = makeService();
    prisma.passkeyCredential.findFirst.mockResolvedValue({ id: 'cred-1', deviceName: 'Laptop' });
    prisma.user.findUnique.mockResolvedValue({ password: 'hashed' });
    prisma.passkeyCredential.count.mockResolvedValue(0);
    prisma.passkeyCredential.update.mockResolvedValue({});

    const result = await service.revokeCredential('user-1', 'cred-1', { password: 'secret' }, '127.0.0.1');
    expect(result).toEqual({ message: 'Passkey berhasil dihapus.' });
    expect(prisma.passkeyCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred-1' },
      data: { revokedAt: expect.any(Date) },
    });
    expect(auditLog.logUserAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PASSKEY_REVOKED' }),
    );
  });
});

describe('PasskeyService policy (G044)', () => {
  test('getRequiredForActions membaca konfigurasi', () => {
    const { service } = makeService({ config: makeConfig({ 'webauthn.requiredFor': ['bank_account_change'] }) });
    expect(service.getRequiredForActions()).toEqual(['bank_account_change']);
  });

  test('requireRecentPasskeyOrReauth lolos bila aksi tidak terdaftar', async () => {
    const { service, authService } = makeService();
    await service.requireRecentPasskeyOrReauth('user-1', 'ubah_foto_profil', {});
    expect(authService.assertPasskeyReauthenticated).not.toHaveBeenCalled();
  });

  test('requireRecentPasskeyOrReauth mewajibkan re-auth bila aksi terdaftar & user punya passkey', async () => {
    const { service, prisma, authService } = makeService();
    prisma.passkeyCredential.count.mockResolvedValue(2);
    await service.requireRecentPasskeyOrReauth('user-1', 'bank_account_change', { password: 'x' });
    expect(authService.assertPasskeyReauthenticated).toHaveBeenCalledWith('user-1', { password: 'x' });
  });
});
