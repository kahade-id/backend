import { Test, TestingModule } from '@nestjs/testing';
import { OpsSettingsService } from '../ops-settings.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { initializeCrypto } from '../../../common/utils/crypto.util';
import { MANAGEABLE_SETTING_MAP } from '../ops-settings.registry';

// Mock ringan: crypto asli dipakai agar roundtrip enkripsi teruji nyata.
jest.mock('../../../prisma/prisma.service');

describe('OpsSettingsService', () => {
  let service: OpsSettingsService;
  const store = new Map<string, any>();
  const audits: any[] = [];

  const mockPrisma: any = {
    appSetting: {
      findMany: jest.fn(async () => [...store.values()]),
      findUnique: jest.fn(async ({ where }: any) => store.get(where.key) ?? null),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const merged = { ...(store.get(where.key) ?? {}), ...create, ...update };
        store.set(where.key, merged);
        return merged;
      }),
    },
    appSettingAudit: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `a${audits.length}`, ...data, createdAt: new Date() };
        audits.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        audits.filter((a) => a.key === where.key).reverse(),
      ),
    },
  };

  beforeEach(async () => {
    initializeCrypto({ aesSecretKey: 'test-aes-secret-key-min-32-chars-ok', hmacSecretKey: 'test-hmac-secret-key-min-32-chars-ok' });
    store.clear();
    audits.length = 0;
    jest.clearAllMocks();
    // findMany mock di-clear oleh clearAllMocks — pasang ulang.
    mockPrisma.appSetting.findMany.mockImplementation(async () => [...store.values()]);
    mockPrisma.appSetting.findUnique.mockImplementation(async ({ where }: any) => store.get(where.key) ?? null);
    mockPrisma.appSetting.upsert.mockImplementation(async ({ where, create, update }: any) => {
      const merged = { ...(store.get(where.key) ?? {}), ...create, ...update };
      store.set(where.key, merged);
      return merged;
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpsSettingsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<OpsSettingsService>(OpsSettingsService);
    // Jangan panggil onModuleInit (ada interval); reload manual.
    await (service as any).reload();
    // Matikan timer bila terlanjur dibuat.
    await service.onModuleDestroy().catch(() => undefined);
  });

  afterEach(async () => {
    await service.onModuleDestroy().catch(() => undefined);
  });

  it('menolak key yang tidak manageable', async () => {
    await expect(service.set('JWT_SECRET', 'x', 'admin1')).rejects.toThrow(/tidak bisa dikelola/);
    await expect(service.set('DATABASE_URL', 'x', 'admin1')).rejects.toThrow(/tidak bisa dikelola/);
  });

  it('registry tidak memuat boot secret', () => {
    for (const k of ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'AES_SECRET_KEY', 'HMAC_SECRET_KEY', 'WALLET_PIN_PEPPER', 'REDIS_URL']) {
      expect(MANAGEABLE_SETTING_MAP.has(k)).toBe(false);
    }
  });

  it('set + get roundtrip secret terenkripsi di DB', async () => {
    const view = await service.set('FONNTE_API_TOKEN', 'tok-abc-1234', 'admin1');
    expect(view.configured).toBe(true);
    expect(view.source).toBe('db');
    // Nilai di DB harus ciphertext, bukan plaintext.
    const raw = store.get('FONNTE_API_TOKEN');
    expect(raw.value).not.toContain('tok-abc-1234');
    expect(raw.value).not.toBe('tok-abc-1234');
    // Nilai efektif terdekripsi dengan benar.
    expect(service.getSecret('FONNTE_API_TOKEN')).toBe('tok-abc-1234');
    // Tampilan termask, tidak membocorkan secret.
    expect(view.displayValue).toBe('••••1234');
    expect(view.displayValue).not.toContain('tok-abc-1234');
  });

  it('fallback ke .env bila belum diset via panel', () => {
    process.env.FONNTE_COUNTRY_CODE = '62';
    try {
      const view = service.list().find((v) => v.key === 'FONNTE_COUNTRY_CODE');
      expect(view?.source).toBe('env');
      expect(service.get('FONNTE_COUNTRY_CODE')).toBe('62');
    } finally {
      delete process.env.FONNTE_COUNTRY_CODE;
    }
  });

  it('audit mencatat SET dengan mask, bukan secret utuh', async () => {
    await service.set('FONNTE_API_TOKEN', 'super-secret-token-xyz', 'admin9');
    const setAudit = audits.find((a) => a.action === 'SET');
    expect(setAudit).toBeDefined();
    expect(setAudit.changedBy).toBe('admin9');
    expect(setAudit.valueHint).toBe('••••-xyz');
    expect(JSON.stringify(audits)).not.toContain('super-secret-token-xyz');
  });

  it('history mengembalikan riwayat terbaru dulu', async () => {
    await service.set('FONNTE_API_TOKEN', 'tok-satu', 'admin1');
    await service.set('FONNTE_API_TOKEN', 'tok-dua', 'admin2');
    const h = await service.history('FONNTE_API_TOKEN');
    expect(h.length).toBe(2);
    expect(h[0].changedBy).toBe('admin2');
  });

  it('menolak value kosong', async () => {
    await expect(service.set('FONNTE_API_TOKEN', '   ', 'admin1')).rejects.toThrow(/tidak boleh kosong/);
  });

  it('SEC-201: set FONNTE_API_URL menolak URL non-HTTPS', async () => {
    await expect(service.set('FONNTE_API_URL', 'http://api.fonnte.com/send', 'admin1')).rejects.toThrow(
      /FONNTE_API_URL tidak valid/,
    );
    expect(store.has('FONNTE_API_URL')).toBe(false);
  });

  it('SEC-201: set FONNTE_API_URL menolak IP metadata cloud & private', async () => {
    await expect(service.set('FONNTE_API_URL', 'https://169.254.169.254/latest/meta-data', 'admin1')).rejects.toThrow(
      /FONNTE_API_URL tidak valid/,
    );
    await expect(service.set('FONNTE_API_URL', 'https://192.168.1.100/send', 'admin1')).rejects.toThrow(
      /FONNTE_API_URL tidak valid/,
    );
    await expect(service.set('FONNTE_API_URL', 'https://10.0.0.5:8443/send', 'admin1')).rejects.toThrow(
      /FONNTE_API_URL tidak valid/,
    );
    expect(store.has('FONNTE_API_URL')).toBe(false);
  });

  it('SEC-201: set FONNTE_API_URL menerima URL publik valid dan menyimpannya ternormalisasi', async () => {
    const view = await service.set('FONNTE_API_URL', 'https://1.1.1.1/send', 'admin1');
    expect(view.configured).toBe(true);
    const raw = store.get('FONNTE_API_URL');
    expect(raw.value).toBe('https://1.1.1.1/send');
    expect(service.get('FONNTE_API_URL')).toBe('https://1.1.1.1/send');
  });

  it('SEC-201: testFonnteToken tidak mengikuti redirect (redirect: manual)', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const origFetch = global.fetch;
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"status":true}' } as any;
    });
    try {
      const result = await (service as any).testFonnteToken('tok-uji');
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].init.redirect).toBe('manual');
    } finally {
      (global as any).fetch = origFetch;
    }
  });
});
