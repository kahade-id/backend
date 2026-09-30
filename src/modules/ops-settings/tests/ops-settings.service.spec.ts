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
      // BAI-104: mock delete untuk "kembalikan ke default".
      delete: jest.fn(async ({ where }: any) => {
        const row = store.get(where.key);
        if (!row) throw new Error('Record to delete does not exist.');
        store.delete(where.key);
        return row;
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
    mockPrisma.appSetting.delete.mockImplementation(async ({ where }: any) => {
      const row = store.get(where.key);
      if (!row) throw new Error('Record to delete does not exist.');
      store.delete(where.key);
      return row;
    });
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

  // ── BAI-104: DELETE / kembalikan ke default ──────────────────────────────
  it('BAI-104: delete menghapus override panel, audit DELETE, fallback ke .env', async () => {
    await service.set('FONNTE_COUNTRY_CODE', '1', 'admin1');
    expect(service.get('FONNTE_COUNTRY_CODE')).toBe('1');
    const view = await service.delete('FONNTE_COUNTRY_CODE', 'admin1');
    expect(store.has('FONNTE_COUNTRY_CODE')).toBe(false);
    expect(view.source).not.toBe('db');
    expect(view.configured).toBe(false); // tanpa .env di lingkungan test
    const last = audits[audits.length - 1];
    expect(last.action).toBe('DELETE');
    expect(last.key).toBe('FONNTE_COUNTRY_CODE');
  });

  it('BAI-104: delete menolak key tanpa override panel', async () => {
    await expect(service.delete('FONNTE_COUNTRY_CODE', 'admin1')).rejects.toThrow(
      /tidak punya override panel/,
    );
  });

  it('BAI-104: delete menolak key yang tidak manageable', async () => {
    await expect(service.delete('JWT_SECRET', 'admin1')).rejects.toThrow(/tidak bisa dikelola/);
  });

  // ── BAI-111: validasi ketat MAINTENANCE_MODE ──────────────────────────────
  it('BAI-111: set MAINTENANCE_MODE menolak "yes"/"1"/"on"', async () => {
    for (const bad of ['yes', '1', 'on', 'aktif']) {
      await expect(service.set('MAINTENANCE_MODE', bad, 'admin1')).rejects.toThrow(
        /hanya menerima "true" atau "false"/,
      );
    }
    expect(store.has('MAINTENANCE_MODE')).toBe(false);
  });

  it('BAI-111: set MAINTENANCE_MODE menerima "true"/"false" (case-insensitive)', async () => {
    await service.set('MAINTENANCE_MODE', 'TRUE', 'admin1');
    expect(service.get('MAINTENANCE_MODE')).toBe('true');
    await service.set('MAINTENANCE_MODE', 'false', 'admin1');
    expect(service.get('MAINTENANCE_MODE')).toBe('false');
  });

  // ── BAI-117: bedakan belum-diset vs gagal-dekripsi ────────────────────────
  it('BAI-117: status "not_set" bila tidak ada baris DB maupun .env', () => {
    const views = (service as any).toView(
      MANAGEABLE_SETTING_MAP.get('FONNTE_API_TOKEN')!,
    );
    expect(views.status).toBe('not_set');
    expect(views.configured).toBe(false);
  });

  it('BAI-117: status "decrypt_failed" bila baris DB ada tapi gagal didekripsi', async () => {
    delete process.env.FONNTE_API_TOKEN; // pastikan fallback .env tidak menutupi
    store.set('FONNTE_API_TOKEN', {
      key: 'FONNTE_API_TOKEN',
      value: 'bukan-ciphertext-valid',
      isSecret: true,
      label: 'Fonnte API Token',
      updatedAt: new Date(),
      updatedBy: 'admin1',
      version: 2,
    });
    await (service as any).reload();
    const view = (service as any).toView(MANAGEABLE_SETTING_MAP.get('FONNTE_API_TOKEN')!);
    expect(view.status).toBe('decrypt_failed');
    expect(view.configured).toBe(false);
    // Fail-closed: nilai korup tidak dipakai sebagai token.
    expect(service.getSecret('FONNTE_API_TOKEN')).toBeUndefined();
  });

  // ── BAI-118: optimistic locking ───────────────────────────────────────────
  it('BAI-118: set dengan expectedVersion cocok berhasil & menaikkan versi', async () => {
    const v1 = await service.set('FONNTE_COUNTRY_CODE', '1', 'admin1');
    expect(v1.version).toBe(1);
    const v2 = await service.set('FONNTE_COUNTRY_CODE', '44', 'admin1', {
      expectedVersion: 1,
    });
    expect(v2.version).toBe(2);
    expect(service.get('FONNTE_COUNTRY_CODE')).toBe('44');
  });

  it('BAI-118: set dengan expectedVersion basi melempar OpsSettingConflictError', async () => {
    const { OpsSettingConflictError } = await import('../ops-settings.service');
    await service.set('FONNTE_COUNTRY_CODE', '1', 'admin1');
    // Simulasi admin B mengubah duluan.
    await service.set('FONNTE_COUNTRY_CODE', '44', 'admin2');
    await expect(
      service.set('FONNTE_COUNTRY_CODE', '81', 'admin1', { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(OpsSettingConflictError);
    // Nilai admin B tetap menang (tidak tertimpa).
    expect(service.get('FONNTE_COUNTRY_CODE')).toBe('44');
  });

  it('BAI-118: baris yang belum pernah diset dianggap versi 0', async () => {
    const { OpsSettingConflictError } = await import('../ops-settings.service');
    await expect(
      service.set('FONNTE_COUNTRY_CODE', '1', 'admin1', { expectedVersion: 5 }),
    ).rejects.toBeInstanceOf(OpsSettingConflictError);
    const view = await service.set('FONNTE_COUNTRY_CODE', '1', 'admin1', {
      expectedVersion: 0,
    });
    expect(view.version).toBe(1);
  });

  // ── BAI-101: validasi lunak env ───────────────────────────────────────────
  it('BAI-101: collectEnvWarnings memberi warning (tanpa throw) untuk token fonnte kosong', async () => {
    const { collectEnvWarnings, validateEnv } = await import('../../../config/env.validation');
    const warnings = collectEnvWarnings({
      OTP_PROVIDER: 'fonnte',
      NODE_ENV: 'development',
    } as any);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/FONNTE_API_TOKEN.*admin panel/);
  });

  it('BAI-101: validateEnv TIDAK memblokir boot karena FONNTE_API_TOKEN kosong (validasi lunak)', async () => {
    const { validateEnv } = await import('../../../config/env.validation');
    try {
      validateEnv({ OTP_PROVIDER: 'fonnte', NODE_ENV: 'development' } as any);
    } catch (e) {
      // Boleh tetap gagal karena var WAJIB lain (SMTP dsb. — fail-closed boot
      // dipertahankan), tapi JANGAN karena token fonnte yang bisa diprovisioning
      // belakangan via panel.
      expect(String((e as Error).message)).not.toMatch(/FONNTE_API_TOKEN/);
    }
  });

  it('BAI-101: tidak ada warning bila token fonnte terisi', async () => {
    const { collectEnvWarnings } = await import('../../../config/env.validation');
    expect(
      collectEnvWarnings({ OTP_PROVIDER: 'fonnte', FONNTE_API_TOKEN: 'tok' } as any),
    ).toHaveLength(0);
  });
});
