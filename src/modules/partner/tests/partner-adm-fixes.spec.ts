/**
 * Test kontrak ADM-304, ADM-306, ADM-308, ADM-309, ADM-310, ADM-326
 * (modul partner — backend).
 *
 * - ADM-304: GET :id/keys ada + detail me-return `keys` teredaksi di level
 *   atas (bukan nested di dalam client).
 * - ADM-306: rotateKey tanpa body mewarisi name/scopes kunci lama; respons
 *   issue/rotate berbentuk { key, plaintext }.
 * - ADM-308: summary me-return `todayCalls`.
 * - ADM-309: quotaUsedPct = Math.round(fraksi * 100) → 450/1000 = 45,
 *   bukan 0/100 (regresi: kurung Math.round).
 * - ADM-310: endpoint teredaksi menyertakan `status` turunan
 *   (ACTIVE / CHALLENGED / DISABLED).
 * - ADM-326: summary me-return `errorRatePct` (persen, 1 desimal).
 */
import 'reflect-metadata';
import { AdminPartnerController } from '../admin-partner.controller';
import { PartnerClientService } from '../partner-client.service';
import { PartnerWebhookService } from '../partner-webhook.service';
import { PartnerUsageService } from '../partner-usage.service';

const CLIENT_ID = 'client-uuid-1';
const KEY_ID = 'key-uuid-1';

function mockClients() {
  return {
    getClient: jest.fn().mockResolvedValue({
      id: CLIENT_ID,
      orgName: 'Mitra Uji',
      status: 'ACTIVE',
      isSandbox: false,
      rateLimitPerMinute: 100,
      quotaPerDay: 1000,
      createdAt: new Date(),
      updatedAt: new Date(),
      // Bentuk yang dikembalikan service nyata: {...client, keys}
      // dengan keys SUDAH teredaksi (redactKey: tanpa keyHash, prefix ***).
      keys: [
        {
          id: KEY_ID,
          clientId: CLIENT_ID,
          keyPrefix: 'kah_test_abcd***',
          scopes: ['orders:read'],
          name: 'kunci-utama',
          expiresAt: null,
          rotatedFromId: null,
          validUntil: null,
          revokedAt: null,
          revokeReason: null,
          lastUsedAt: null,
          createdAt: new Date(),
        },
      ],
    }),
  };
}

function makeController(clients: any, webhooks: any, usage: any) {
  return new AdminPartnerController(clients, webhooks, usage);
}

describe('ADM-304 — keys diekspos di detail + endpoint GET :id/keys', () => {
  it('getClient: respons { client, keys, endpoints, usage } — keys teredaksi', async () => {
    const clients = mockClients();
    const webhooks = { listEndpoints: jest.fn().mockResolvedValue([]) };
    const usage = { summary: jest.fn().mockResolvedValue({ todayCalls: 0 }) };
    const res: any = await makeController(clients as never, webhooks as never, usage as never).getClient(CLIENT_ID);
    expect(Array.isArray(res.keys)).toBe(true);
    expect(res.keys).toHaveLength(1);
    expect(res.keys[0].id).toBe(KEY_ID);
    expect(res.keys[0].name).toBe('kunci-utama');
    expect(res.keys[0].keyHash).toBeUndefined();
    expect(res.keys[0].keyPrefix).toContain('***');
    // keys tidak nested di dalam client
    expect((res.client as Record<string, unknown>)['keys']).toBeUndefined();
    expect(res.endpoints).toEqual([]);
  });

  it('listKeys: GET :id/keys me-return { clientId, keys }', async () => {
    const clients = mockClients();
    const res: any = await makeController(
      clients as never, { listEndpoints: jest.fn() } as never, { summary: jest.fn() } as never,
    ).listKeys(CLIENT_ID);
    expect(res.clientId).toBe(CLIENT_ID);
    expect(res.keys).toHaveLength(1);
    expect(res.keys[0].keyHash).toBeUndefined();
  });
});

describe('ADM-306 — rotate tanpa body mewarisi kunci lama', () => {
  function makeService() {
    const oldKey = {
      id: KEY_ID,
      clientId: CLIENT_ID,
      keyPrefix: 'kah_test_abcd',
      keyHash: 'oldhash',
      scopes: ['orders:read', 'webhooks:write'],
      name: 'kunci-utama',
      expiresAt: null,
      rotatedFromId: null,
      validUntil: null,
      revokedAt: null,
      revokeReason: null,
      lastUsedAt: null,
      createdAt: new Date(),
    };
    const prisma: any = {
      apiClient: {
        findUnique: jest.fn().mockResolvedValue({
          id: CLIENT_ID, orgName: 'Mitra Uji', status: 'ACTIVE', isSandbox: false,
        }),
      },
      partnerApiKey: {
        findUnique: jest.fn().mockResolvedValue(oldKey),
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'new-key', ...data })),
        update: jest.fn().mockResolvedValue({}),
      },
      partnerAuditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new PartnerClientService(prisma);
    return { service, prisma, oldKey };
  }

  it('rotate {} → kunci baru pakai name & scopes kunci lama', async () => {
    const { service, prisma } = makeService();
    const res = await service.rotateKey(CLIENT_ID, KEY_ID, {}, 'admin-1', '127.0.0.1');
    const created = prisma.partnerApiKey.create.mock.calls[0][0].data;
    expect(created.name).toBe('kunci-utama');
    expect(created.scopes).toEqual(['orders:read', 'webhooks:write']);
    expect(res.plaintext).toBeTruthy();
    expect(res.key.id).toBe('new-key');
    // kontrak respons { key, plaintext }
    expect(res).toHaveProperty('key');
    expect(res).toHaveProperty('plaintext');
  });

  it('rotate dengan name eksplisit menimpa nama lama', async () => {
    const { service, prisma } = makeService();
    await service.rotateKey(CLIENT_ID, KEY_ID, { name: 'kunci-baru' }, 'admin-1', '127.0.0.1');
    const created = prisma.partnerApiKey.create.mock.calls[0][0].data;
    expect(created.name).toBe('kunci-baru');
    expect(created.scopes).toEqual(['orders:read', 'webhooks:write']);
  });
});

describe('ADM-308/309/326 — usage summary', () => {
  function makeService(todayCount: number, errorCount: number, quota: number) {
    const today = new Date();
    const dayKey = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const prisma: any = {
      apiClient: {
        findUnique: jest.fn().mockResolvedValue({ id: CLIENT_ID, orgName: 'Mitra', quotaPerDay: quota }),
      },
      partnerApiUsage: {
        findMany: jest.fn().mockResolvedValue([
          { clientId: CLIENT_ID, date: dayKey, count: todayCount, errorCount },
        ]),
      },
    };
    return new PartnerUsageService(prisma);
  }

  it('ADM-308: todayCalls tersedia; ADM-309: 450/1000 → 45%', async () => {
    const res: any = await makeService(450, 0, 1000).summary(CLIENT_ID);
    expect(res.todayCalls).toBe(450);
    expect(res.quotaUsedPct).toBe(45);
  });

  it('ADM-309 regresi: 600/1000 → 60% (bukan 100%)', async () => {
    const res: any = await makeService(600, 0, 1000).summary(CLIENT_ID);
    expect(res.quotaUsedPct).toBe(60);
  });

  it('ADM-326: errorRatePct persen 1 desimal (5/200 → 2.5)', async () => {
    const res: any = await makeService(200, 5, 1000).summary(CLIENT_ID);
    expect(res.errorRatePct).toBe(2.5);
  });

  it('errorRatePct = 0 bila tidak ada panggilan', async () => {
    const res: any = await makeService(0, 0, 1000).summary(CLIENT_ID);
    expect(res.errorRatePct).toBe(0);
    expect(res.quotaUsedPct).toBe(0);
  });
});

describe('ADM-310 — status endpoint turunan', () => {
  function redact(service: PartnerWebhookService, overrides: Record<string, unknown>) {
    return (service as any).redactEndpoint({
      id: 'ep-1',
      clientId: CLIENT_ID,
      url: 'https://mitra.example.com/wh',
      events: ['order.paid'],
      secretEnc: 'enc',
      challengeToken: null,
      isActive: false,
      verifiedAt: null,
      challengeIssuedAt: null,
      lastDeliveryAt: null,
      lastDeliveryStatus: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });
  }

  it('verifiedAt + isActive → ACTIVE', () => {
    const service = new PartnerWebhookService({} as never, {} as never);
    const r = redact(service, { isActive: true, verifiedAt: new Date() });
    expect(r.status).toBe('ACTIVE');
    expect(r.secretEnc).toBeUndefined();
    expect(r.challengeToken).toBeUndefined();
  });

  it('challengeIssuedAt tanpa verifiedAt → CHALLENGED', () => {
    const service = new PartnerWebhookService({} as never, {} as never);
    const r = redact(service, { isActive: true, challengeIssuedAt: new Date() });
    expect(r.status).toBe('CHALLENGED');
  });

  it('tidak aktif / belum terverifikasi → DISABLED', () => {
    const service = new PartnerWebhookService({} as never, {} as never);
    expect(redact(service, {}).status).toBe('DISABLED');
    expect(redact(service, { isActive: false, verifiedAt: new Date() }).status).toBe('DISABLED');
  });
});
