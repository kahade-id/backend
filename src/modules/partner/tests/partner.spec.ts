// GAP-F (G475): spec tests — signature, SSRF, retry→DLQ, rotation overlap,
// rate limit 429, sandbox isolation.

import { HttpException, HttpStatus } from '@nestjs/common';
import { signWebhookPayload, verifyWebhookSignature } from '../webhook-signer.util';
import {
  generatePartnerApiKey,
  hashPartnerApiKey,
  verifyPartnerApiKey,
  partnerKeyIdent,
} from '../partner-api-key.util';
import { isBlockedIp, validateWebhookUrl, WebhookUrlValidationError } from '../ssrf.util';
import {
  PartnerWebhookService,
  retryDelayForAttempt,
} from '../partner-webhook.service';
import { PartnerClientService } from '../partner-client.service';
import { PartnerApiKeyGuard } from '../partner-api-key.guard';
import { PartnerScopeGuard } from '../partner-scope.guard';
import { PartnerRateLimitGuard } from '../partner-rate-limit.guard';
import {
  PARTNER_WEBHOOK_MAX_ATTEMPTS,
  PARTNER_WEBHOOK_RETRY_DELAYS_MS,
} from '../partner.constants';

// Re-export test hook (defined below via module augmentation is overkill; use direct fns).
// The service exports computeNextStep as a method — bind a lightweight instance.

describe('webhook signer (G464)', () => {
  const secret = 'test-secret-123';
  const ts = '1758844800000';
  const eventId = 'evt-1';
  const body = '{"a":1}';

  it('verifies a valid signature', () => {
    const sig = signWebhookPayload(secret, ts, eventId, body);
    expect(verifyWebhookSignature(secret, ts, eventId, body, sig)).toBe(true);
  });

  it('rejects tampered body / secret / timestamp / eventId', () => {
    const sig = signWebhookPayload(secret, ts, eventId, body);
    expect(verifyWebhookSignature(secret, ts, eventId, '{"a":2}', sig)).toBe(false);
    expect(verifyWebhookSignature('wrong', ts, eventId, body, sig)).toBe(false);
    expect(verifyWebhookSignature(secret, '0', eventId, body, sig)).toBe(false);
    expect(verifyWebhookSignature(secret, ts, 'evt-2', body, sig)).toBe(false);
  });

  it('rejects malformed signature in constant time-safe manner', () => {
    expect(verifyWebhookSignature(secret, ts, eventId, body, 'not-hex')).toBe(false);
    expect(verifyWebhookSignature(secret, ts, eventId, body, '')).toBe(false);
  });
});

describe('SSRF protection (G470)', () => {
  it('blocks private/reserved ranges via isBlockedIp', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true);
    expect(isBlockedIp('10.0.0.5')).toBe(true);
    expect(isBlockedIp('172.16.9.9')).toBe(true);
    expect(isBlockedIp('192.168.1.1')).toBe(true);
    expect(isBlockedIp('169.254.169.254')).toBe(true); // cloud metadata
    expect(isBlockedIp('::1')).toBe(true);
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('1.1.1.1')).toBe(false);
  });

  it('rejects non-HTTPS', async () => {
    await expect(validateWebhookUrl('http://example.com/hook')).rejects.toThrow(WebhookUrlValidationError);
  });

  it('rejects credentials in URL', async () => {
    await expect(validateWebhookUrl('https://user:pass@example.com/hook')).rejects.toThrow(WebhookUrlValidationError);
  });

  it('rejects non-443 ports', async () => {
    await expect(validateWebhookUrl('https://example.com:8080/hook')).rejects.toThrow(WebhookUrlValidationError);
  });

  it('rejects literal private IPs without DNS', async () => {
    await expect(validateWebhookUrl('https://127.0.0.1/hook')).rejects.toThrow(WebhookUrlValidationError);
    await expect(validateWebhookUrl('https://10.1.2.3/hook')).rejects.toThrow(WebhookUrlValidationError);
  });

  it('rejects cloud metadata endpoints', async () => {
    await expect(validateWebhookUrl('https://169.254.169.254/latest')).rejects.toThrow(WebhookUrlValidationError);
  });

  it('rejects hostnames resolving to private IPs (localhost)', async () => {
    await expect(validateWebhookUrl('https://localhost/hook')).rejects.toThrow(WebhookUrlValidationError);
  });
});

describe('API key crypto (G453)', () => {
  it('generates verifiable keys; hash never equals plaintext', async () => {
    const { plaintext, keyPrefix } = generatePartnerApiKey(false);
    expect(plaintext.startsWith('kh_live_')).toBe(true);
    expect(keyPrefix).toHaveLength(8);
    const hash = await hashPartnerApiKey(plaintext);
    expect(hash).not.toContain(plaintext.slice(8, 20));
    expect(await verifyPartnerApiKey(plaintext, hash)).toBe(true);
    expect(await verifyPartnerApiKey(plaintext + 'x', hash)).toBe(false);
    expect(partnerKeyIdent(plaintext)).toBe(keyPrefix);
  });

  it('sandbox keys use the sandbox prefix', () => {
    const { plaintext } = generatePartnerApiKey(true);
    expect(plaintext.startsWith('kh_sandbox_')).toBe(true);
  });
});

describe('retry schedule → DLQ (G466)', () => {
  it('uses the exact exponential schedule 1m/5m/15m/1h/6h', () => {
    expect(PARTNER_WEBHOOK_RETRY_DELAYS_MS).toEqual([60_000, 300_000, 900_000, 3_600_000, 21_600_000]);
    expect(PARTNER_WEBHOOK_MAX_ATTEMPTS).toBe(6);
    expect(retryDelayForAttempt(1)).toBe(60_000);
    expect(retryDelayForAttempt(5)).toBe(21_600_000);
    expect(retryDelayForAttempt(6)).toBeNull();
  });

  it('moves to DLQ after the 6th failed attempt', () => {
    // computeNextStep is a service method; exercise through a bare instance.
    const svc = new (PartnerWebhookService as unknown as new () => { computeNextStep(a: number): unknown })();
    const real = PartnerWebhookService.prototype.computeNextStep.bind(svc);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const step = real(attempt) as { status: string; nextRetryAt: Date | null };
      expect(step.status).toBe('PENDING');
      expect(step.nextRetryAt).toBeInstanceOf(Date);
    }
    const dead = real(6) as { status: string; nextRetryAt: Date | null };
    expect(dead.status).toBe('DLQ');
    expect(dead.nextRetryAt).toBeNull();
  });
});

describe('key rotation overlap (G455)', () => {
  function makeService() {
    const prisma = {
      apiClient: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      partnerApiKey: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      partnerAuditLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn() },
    };
    const svc = new PartnerClientService(prisma as never);
    return { svc, prisma };
  }

  it('rotated key stays valid 24h; new key links rotatedFromId', async () => {
    const { svc, prisma } = makeService();
    const client = { id: 'c1', orgName: 'Mitra', status: 'ACTIVE', isSandbox: false };
    const oldKey = { id: 'k-old', clientId: 'c1', keyPrefix: 'aaaaaaaa', keyHash: 'h', name: 'old', revokedAt: null, client };
    prisma.apiClient.findUnique.mockResolvedValue(client);
    prisma.partnerApiKey.findUnique.mockResolvedValue(oldKey);
    prisma.partnerApiKey.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'k-new',
      ...data,
    }));
    prisma.partnerApiKey.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);

    const before = Date.now();
    const { key, plaintext } = await svc.rotateKey(
      'c1',
      'k-old',
      { name: 'baru', scopes: ['orders:read'] },
      'admin-1',
      '127.0.0.1',
    );

    expect(plaintext.startsWith('kh_live_')).toBe(true);
    expect(key.rotatedFromId).toBe('k-old');
    // Old key got the 24h overlap window.
    const overlapCall = prisma.partnerApiKey.update.mock.calls.find(
      ([args]: [{ where: { id: string } }]) => args.where.id === 'k-old',
    );
    const validUntil = (overlapCall![0] as { data: { validUntil: Date } }).data.validUntil;
    const diff = validUntil.getTime() - before;
    expect(diff).toBeGreaterThan(23.9 * 3600_000);
    expect(diff).toBeLessThanOrEqual(24 * 3600_000 + 60_000);
    // Audit trail written for both issue + rotate.
    expect(prisma.partnerAuditLog.create).toHaveBeenCalled();
  });

  it('refuses to rotate a revoked key', async () => {
    const { svc, prisma } = makeService();
    prisma.partnerApiKey.findUnique.mockResolvedValue({ id: 'k-old', clientId: 'c1', revokedAt: new Date() });
    await expect(
      svc.rotateKey('c1', 'k-old', { name: 'x', scopes: ['orders:read'] }, 'admin-1', '127.0.0.1'),
    ).rejects.toThrow();
  });
});

describe('rate limit guard (G460)', () => {
  function makeGuard(allowed: boolean) {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) };
    const redis = {
      evalSlidingWindow: jest.fn().mockResolvedValue(allowed),
      getClient: jest.fn().mockReturnValue({ incr: jest.fn().mockResolvedValue(1), expire: jest.fn().mockResolvedValue(1) }),
      getPrefix: jest.fn().mockReturnValue('test:'),
    };
    const guard = new PartnerRateLimitGuard(reflector as never, redis as never);
    const setHeader = jest.fn();
    const req = {
      partner: { clientId: 'c1', keyId: 'k1', scopes: [], isSandbox: false, rateLimitPerMinute: 100, quotaPerDay: 10000 },
      method: 'GET',
      path: '/v1/partner/orders/ORD-1',
      route: { path: '/partner/orders/:publicId' },
    };
    const res = { setHeader };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      getHandler: () => ({}),
      getClass: () => ({}),
    };
    return { guard, ctx: ctx as never, setHeader };
  }

  it('allows under the limit', async () => {
    const { guard, ctx } = makeGuard(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('responds 429 with Retry-After when over the limit', async () => {
    const { guard, ctx, setHeader } = makeGuard(false);
    const err = await guard.canActivate(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });
});

describe('sandbox isolation (G458)', () => {
  async function attempt(path: string, isSandboxClient: boolean) {
    const { plaintext } = generatePartnerApiKey(isSandboxClient);
    const hash = await hashPartnerApiKey(plaintext);
    const client = {
      id: 'c1',
      orgName: 'Mitra',
      status: 'ACTIVE',
      isSandbox: isSandboxClient,
      rateLimitPerMinute: 100,
      quotaPerDay: 10000,
    };
    const keyRow = {
      id: 'k1',
      clientId: 'c1',
      keyPrefix: plaintext.slice(isSandboxClient ? 'kh_sandbox_'.length : 'kh_live_'.length, isSandboxClient ? 'kh_sandbox_'.length + 8 : 'kh_live_'.length + 8),
      keyHash: hash,
      scopes: ['orders:read'],
      expiresAt: null,
      validUntil: null,
      revokedAt: null,
      client,
    };
    const prisma = {
      partnerApiKey: {
        findMany: jest.fn().mockResolvedValue([keyRow]),
        update: jest.fn().mockResolvedValue({}),
      },
      apiClient: { findUnique: jest.fn() },
    };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) };
    const guard = new PartnerApiKeyGuard(reflector as never, prisma as never);
    const req: Record<string, unknown> = {
      headers: { 'x-api-key': plaintext },
      path,
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    };
    return guard.canActivate(ctx as never).then(
      () => ({ ok: true as const, partner: req['partner'] as { isSandbox: boolean } }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );
  }

  it('rejects sandbox keys on production routes', async () => {
    const res = await attempt('/v1/partner/orders/ORD-1', true);
    expect(res.ok).toBe(false);
  });

  it('accepts sandbox keys on sandbox routes', async () => {
    const res = await attempt('/v1/partner-sandbox/orders/ORD-1', true);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.partner.isSandbox).toBe(true);
  });

  it('rejects production keys on sandbox routes', async () => {
    const res = await attempt('/v1/partner-sandbox/orders/ORD-1', false);
    expect(res.ok).toBe(false);
  });
});

describe('scope guard (G454)', () => {
  function makeCtx(scopes: string[], required: string[] | undefined) {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(required) };
    const guard = new PartnerScopeGuard(reflector as never);
    const req = { partner: { scopes } };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    };
    return { guard, ctx: ctx as never };
  }

  it('allows when all required scopes present', () => {
    const { guard, ctx } = makeCtx(['orders:read', 'webhooks:manage'], ['orders:read']);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('denies with 403 when a scope is missing', () => {
    const { guard, ctx } = makeCtx(['orders:read'], ['webhooks:manage']);
    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
    try {
      guard.canActivate(ctx);
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(HttpStatus.FORBIDDEN);
    }
  });
});
