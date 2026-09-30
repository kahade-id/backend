import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptPii, decryptPiiSafe } from '../../common/utils/pii.util';
import {
  MANAGEABLE_SETTINGS,
  MANAGEABLE_SETTING_MAP,
  isManageableSetting,
  maskSecret,
  type ManageableSettingDef,
} from './ops-settings.registry';
// SEC-201: validasi SSRF untuk FONNTE_API_URL sebelum disimpan — pola yang
// sama dipakai webhook mitra (partner/ssrf.util.ts).
import { validateWebhookUrl, WebhookUrlValidationError } from '../partner/ssrf.util';

/** Default endpoint kirim Fonnte — dipakai test koneksi bila FONNTE_API_URL belum diset. */
const DEFAULT_FONNTE_SEND_URL = 'https://api.fonnte.com/send';

export interface OpsSettingView {
  key: string;
  label: string;
  description: string;
  isSecret: boolean;
  testable: boolean;
  /** Nilai mask ("••••ab12") untuk secret, nilai asli untuk non-secret, null bila kosong */
  displayValue: string | null;
  configured: boolean;
  /** 'db' | 'env' | null — dari mana nilai efektif berasal */
  source: 'db' | 'env' | null;
  /** BAI-117: 'ok' | 'not_set' | 'decrypt_failed' — bedakan "belum diset"
   *  dari "baris DB ada tapi gagal didekripsi". */
  status: 'ok' | 'not_set' | 'decrypt_failed';
  updatedAt: Date | null;
  updatedBy: string | null;
  version: number;
}

/** BAI-118: dilempar set() bila expectedVersion tidak cocok — controller memetakan ke 409. */
export class OpsSettingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpsSettingConflictError';
  }
}

export interface SetOpsSettingOptions {
  /** BAI-118: optimistic locking — tolak bila versi DB tidak cocok. */
  expectedVersion?: number;
  /** BAI-113: aksi audit kustom (default 'SET'), mis. 'MESSAGE_UPDATED'. */
  auditAction?: string;
}

interface CachedSecret {
  encrypted: string;
  decrypted: string;
}

/**
 * OPS — Layanan setting operasional (pengganti .env untuk key operasional).
 *
 * - Nilai dibaca sinkron dari cache memori (refresh tiap 60 dtk + saat ada
 *   perubahan), fallback ke process.env bila belum pernah diset via panel.
 * - Secret disimpan terenkripsi AES-GCM di tabel app_settings.
 * - HANYA key di MANAGEABLE_SETTINGS yang bisa ditulis — boot secret tidak
 *   bisa disentuh dari sini by design.
 */
@Injectable()
export class OpsSettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OpsSettingsService.name);
  private readonly secrets = new Map<string, CachedSecret>();
  private readonly plains = new Map<string, string>();
  private readonly meta = new Map<string, { updatedAt: Date; updatedBy: string | null; version: number }>();
  /** BAI-117: key yang baris DB-nya ada tetapi GAGAL didekripsi. */
  private readonly decryptFailed = new Set<string>();
  private refreshTimer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
    // Refresh berkala — bila ada yang mengubah langsung di DB, cache ikut segar.
    this.refreshTimer = setInterval(() => {
      void this.reload().catch((e) => this.logger.warn(`Ops settings refresh failed: ${e}`));
    }, 60_000);
    if (this.refreshTimer.unref) this.refreshTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  private async reload(): Promise<void> {
    let rows: Array<{ key: string; value: string; isSecret: boolean; updatedAt: Date; updatedBy: string | null; version: number }>;
    try {
      rows = await this.prisma.appSetting.findMany();
    } catch (err) {
      // DB belum migrasi / belum siap — jangan gagalkan boot, pakai env saja.
      this.logger.warn(`app_settings tidak bisa dibaca (${err instanceof Error ? err.message : err}) — memakai .env saja.`);
      return;
    }
    this.secrets.clear();
    this.plains.clear();
    this.meta.clear();
    this.decryptFailed.clear();
    for (const row of rows) {
      if (!isManageableSetting(row.key)) continue; // abaikan key asing
      this.meta.set(row.key, { updatedAt: row.updatedAt, updatedBy: row.updatedBy, version: row.version });
      if (row.isSecret) {
        const decrypted = await decryptPiiSafe(row.value);
        if (decrypted === null) {
          // BAI-117: catat sebagai gagal dekripsi (fail-closed: nilai tidak
          // dipakai) agar toView() bisa menampilkannya berbeda dari
          // "belum diset".
          this.logger.error(`Ops setting ${row.key} gagal didekripsi — dilewati (fail-closed).`);
          this.decryptFailed.add(row.key);
          continue;
        }
        this.secrets.set(row.key, { encrypted: row.value, decrypted });
      } else {
        this.plains.set(row.key, row.value);
      }
    }
  }

  /** Nilai efektif: DB (panel) menang atas .env. */
  get(key: string): string | undefined {
    const s = this.secrets.get(key);
    if (s) return s.decrypted;
    const p = this.plains.get(key);
    if (p !== undefined) return p;
    return process.env[key];
  }

  /** Alias eksplisit untuk secret. */
  getSecret(key: string): string | undefined {
    return this.get(key);
  }

  has(key: string): boolean {
    return !!this.get(key);
  }

  list(): OpsSettingView[] {
    return MANAGEABLE_SETTINGS.map((def) => this.toView(def));
  }

  getDefinition(key: string): ManageableSettingDef | undefined {
    return MANAGEABLE_SETTING_MAP.get(key);
  }

  private toView(def: ManageableSettingDef): OpsSettingView {
    const fromDb = def.isSecret ? this.secrets.get(def.key) : undefined;
    const plainDb = !def.isSecret ? this.plains.get(def.key) : undefined;
    const m = this.meta.get(def.key);
    const envVal = process.env[def.key];
    const dbVal = def.isSecret ? fromDb?.decrypted : plainDb;
    const effective = dbVal !== undefined ? dbVal : envVal;
    // BAI-117: bedakan "belum diset" dari "gagal dekripsi".
    const status: OpsSettingView['status'] = this.decryptFailed.has(def.key)
      ? 'decrypt_failed'
      : effective !== undefined
        ? 'ok'
        : 'not_set';
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      isSecret: def.isSecret,
      testable: def.testable,
      displayValue: def.isSecret ? maskSecret(effective) : effective ?? null,
      configured: !!effective,
      source: dbVal !== undefined ? 'db' : envVal ? 'env' : null,
      status,
      updatedAt: m?.updatedAt ?? null,
      updatedBy: m?.updatedBy ?? null,
      version: m?.version ?? 0,
    };
  }

  /** BAI-114: metadata baris DB (updatedAt/updatedBy/version) untuk satu key. */
  getMeta(key: string): { updatedAt: Date; updatedBy: string | null; version: number } | undefined {
    return this.meta.get(key);
  }

  /**
   * Tulis setting via admin panel. Hanya key terdaftar yang diterima.
   * @throws Error bila key tidak manageable, value kosong/tidak valid.
   * @throws OpsSettingConflictError (BAI-118) bila expectedVersion diberikan
   *   dan tidak cocok dengan versi DB saat ini.
   */
  async set(key: string, value: string, adminId: string, opts: SetOpsSettingOptions = {}): Promise<OpsSettingView> {
    const def = MANAGEABLE_SETTING_MAP.get(key);
    if (!def) {
      throw new Error(`Setting "${key}" tidak bisa dikelola via admin panel.`);
    }
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error(`Nilai ${key} tidak boleh kosong.`);
    }
    // BAI-111: validasi ketat untuk flag boolean — nilai selain "true"/"false"
    // DITOLAK (400), bukan diam-diam dianggap false. Middleware hanya
    // menganggap "true" sebagai aktif, jadi "yes"/"1"/"on" sebelumnya bisa
    // menyesatkan admin.
    if (key === 'MAINTENANCE_MODE' && !['true', 'false'].includes(trimmed.toLowerCase())) {
      throw new Error(`MAINTENANCE_MODE hanya menerima "true" atau "false".`);
    }
    // SEC-201: FONNTE_API_URL dipakai sebagai target fetch server-side —
    // validasi anti-SSRF (HTTPS saja, tanpa kredensial, port 443, hostname
    // tidak me-resolve ke IP private/reserved/metadata) + normalisasi
    // sebelum disimpan. Gagal validasi → tolak, nilai lama dipertahankan.
    let effectiveValue = trimmed;
    if (key === 'FONNTE_API_URL') {
      try {
        effectiveValue = await validateWebhookUrl(trimmed);
      } catch (err) {
        const reason = err instanceof WebhookUrlValidationError ? err.message : String(err);
        throw new Error(`FONNTE_API_URL tidak valid: ${reason}`);
      }
    }
    // BAI-111: simpan flag boolean dalam bentuk kanonis lowercase agar
    // displayValue & pembanding konsisten ("TRUE" → "true").
    if (key === 'MAINTENANCE_MODE' || key === 'WALLET_ENABLED') {
      effectiveValue = trimmed.toLowerCase();
    }
    const stored = def.isSecret ? await encryptPii(effectiveValue) : effectiveValue;
    const existing = await this.prisma.appSetting.findUnique({ where: { key } });
    // BAI-118: optimistic locking — baris yang belum pernah diset via panel
    // dianggap versi 0.
    if (opts.expectedVersion !== undefined && (existing?.version ?? 0) !== opts.expectedVersion) {
      throw new OpsSettingConflictError(
        `Setting "${key}" sudah berubah (versi ${existing?.version ?? 0}) sejak Anda memuat halaman. Muat ulang dan ulangi perubahan.`,
      );
    }
    const nextVersion = (existing?.version ?? 0) + 1;
    await this.prisma.appSetting.upsert({
      where: { key },
      create: {
        key,
        value: stored,
        isSecret: def.isSecret,
        label: def.label,
        updatedBy: adminId,
        version: nextVersion,
      },
      update: { value: stored, isSecret: def.isSecret, label: def.label, updatedBy: adminId, version: nextVersion },
    });
    // BAI-113: aksi audit bisa dioverride (mis. 'MESSAGE_UPDATED') agar
    // perubahan pesan tidak tercatat seolah mode di-toggle.
    const auditAction = opts.auditAction ?? 'SET';
    await this.prisma.appSettingAudit.create({
      data: {
        key,
        action: auditAction,
        changedBy: adminId,
        valueHint: def.isSecret ? maskSecret(effectiveValue) : effectiveValue.slice(0, 64),
        success: true,
        detail: `version ${nextVersion}`,
      },
    });
    await this.reload();
    this.logger.log(`Ops setting ${key} diubah oleh admin ${adminId} (v${nextVersion}, aksi ${auditAction}).`);
    return this.toView(def);
  }

  /**
   * BAI-104: hapus override panel untuk satu key — nilai kembali ke
   * default/.env (fail-closed: tidak ada nilai panel = fallback normal).
   * Diaudit sebagai 'DELETE'. Nilai secret tidak pernah ditulis ke audit.
   * @throws Error bila key tidak manageable atau tidak punya override panel.
   */
  async delete(key: string, adminId: string): Promise<OpsSettingView> {
    const def = MANAGEABLE_SETTING_MAP.get(key);
    if (!def) {
      throw new Error(`Setting "${key}" tidak bisa dikelola via admin panel.`);
    }
    const existing = await this.prisma.appSetting.findUnique({ where: { key } });
    if (!existing) {
      throw new Error(`Setting "${key}" tidak punya override panel — sudah memakai default/.env.`);
    }
    await this.prisma.appSetting.delete({ where: { key } });
    await this.prisma.appSettingAudit.create({
      data: {
        key,
        action: 'DELETE',
        changedBy: adminId,
        valueHint: null,
        success: true,
        detail: 'Override panel dihapus — kembali ke default/.env',
      },
    });
    await this.reload();
    this.logger.log(`Ops setting ${key} dikembalikan ke default oleh admin ${adminId}.`);
    return this.toView(def);
  }

  /** Riwayat perubahan — hanya mask, tidak pernah secret utuh. */
  async history(key: string, limit = 20): Promise<Array<{
    id: string; action: string; changedBy: string; valueHint: string | null;
    success: boolean | null; detail: string | null; createdAt: Date;
  }>> {
    if (!isManageableSetting(key)) throw new Error(`Setting "${key}" tidak dikenal.`);
    return this.prisma.appSettingAudit.findMany({
      where: { key },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      select: { id: true, action: true, changedBy: true, valueHint: true, success: true, detail: true, createdAt: true },
    });
  }

  /**
   * Test koneksi untuk setting yang testable (saat ini: FONNTE_API_TOKEN).
   * Memakai nilai kandidat (belum disimpan) bila diberikan, agar admin bisa
   * validasi SEBELUM menyimpan.
   */
  async testConnection(key: string, adminId: string, candidateValue?: string): Promise<{ ok: boolean; message: string }> {
    const def = MANAGEABLE_SETTING_MAP.get(key);
    if (!def) throw new Error(`Setting "${key}" tidak dikenal.`);
    if (!def.testable) throw new Error(`Setting "${key}" tidak mendukung test koneksi.`);
    const token = (candidateValue?.trim() || this.getSecret(key) || '').trim();
    let result: { ok: boolean; message: string };
    if (key === 'FONNTE_API_TOKEN') {
      result = await this.testFonnteToken(token);
    } else {
      result = { ok: false, message: 'Belum ada test untuk setting ini.' };
    }
    await this.prisma.appSettingAudit.create({
      data: {
        key,
        action: 'TEST',
        changedBy: adminId,
        valueHint: maskSecret(token),
        success: result.ok,
        detail: result.message.slice(0, 500),
      },
    });
    return result;
  }

  /**
   * BAI-107: endpoint /get-devices diturunkan dari FONNTE_API_URL yang
   * dikonfigurasi (DB panel > .env), bukan hardcode — agar "test koneksi"
   * memvalidasi endpoint yang sama dengan jalur pengiriman nyata.
   */
  private fonnteDevicesUrl(): string {
    const configured = (this.get('FONNTE_API_URL') || '').trim() || DEFAULT_FONNTE_SEND_URL;
    const normalized = configured.replace(/\/+$/, '');
    // FONNTE_API_URL menunjuk ke /send; endpoint test adalah /get-devices
    // pada host yang sama.
    return normalized.toLowerCase().endsWith('/send')
      ? `${normalized.slice(0, -'/send'.length)}/get-devices`
      : `${normalized}/get-devices`;
  }

  private async testFonnteToken(token: string): Promise<{ ok: boolean; message: string }> {
    if (!token) return { ok: false, message: 'Token kosong.' };
    const devicesUrl = this.fonnteDevicesUrl();
    try {
      const res = await fetch(devicesUrl, {
        method: 'POST',
        // SEC-201: jangan ikuti redirect (anti-SSRF via open redirect).
        redirect: 'manual',
        headers: { Authorization: token },
      });
      const text = await res.text();
      // Fonnte mengembalikan JSON; token salah → "unknown user".
      if (res.ok && !/unknown user/i.test(text)) {
        return { ok: true, message: `Token valid — terhubung ke Fonnte (${devicesUrl}).` };
      }
      return { ok: false, message: `Fonnte menolak token (${devicesUrl}, HTTP ${res.status}). Periksa kembali token di dashboard Fonnte.` };
    } catch (err) {
      return { ok: false, message: `Gagal menghubungi Fonnte (${devicesUrl}): ${err instanceof Error ? err.message : err}` };
    }
  }
}
