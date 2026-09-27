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
  updatedAt: Date | null;
  updatedBy: string | null;
  version: number;
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
    for (const row of rows) {
      if (!isManageableSetting(row.key)) continue; // abaikan key asing
      this.meta.set(row.key, { updatedAt: row.updatedAt, updatedBy: row.updatedBy, version: row.version });
      if (row.isSecret) {
        const decrypted = await decryptPiiSafe(row.value);
        if (decrypted === null) {
          this.logger.error(`Ops setting ${row.key} gagal didekripsi — dilewati (fail-closed).`);
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
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      isSecret: def.isSecret,
      testable: def.testable,
      displayValue: def.isSecret ? maskSecret(effective) : effective ?? null,
      configured: !!effective,
      source: dbVal !== undefined ? 'db' : envVal ? 'env' : null,
      updatedAt: m?.updatedAt ?? null,
      updatedBy: m?.updatedBy ?? null,
      version: m?.version ?? 0,
    };
  }

  /**
   * Tulis setting via admin panel. Hanya key terdaftar yang diterima.
   * @throws Error bila key tidak manageable atau value kosong.
   */
  async set(key: string, value: string, adminId: string): Promise<OpsSettingView> {
    const def = MANAGEABLE_SETTING_MAP.get(key);
    if (!def) {
      throw new Error(`Setting "${key}" tidak bisa dikelola via admin panel.`);
    }
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error(`Nilai ${key} tidak boleh kosong.`);
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
    const stored = def.isSecret ? await encryptPii(effectiveValue) : effectiveValue;
    const existing = await this.prisma.appSetting.findUnique({ where: { key } });
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
    await this.prisma.appSettingAudit.create({
      data: {
        key,
        action: 'SET',
        changedBy: adminId,
        valueHint: def.isSecret ? maskSecret(effectiveValue) : effectiveValue.slice(0, 64),
        success: true,
        detail: `version ${nextVersion}`,
      },
    });
    await this.reload();
    this.logger.log(`Ops setting ${key} diubah oleh admin ${adminId} (v${nextVersion}).`);
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

  private async testFonnteToken(token: string): Promise<{ ok: boolean; message: string }> {
    if (!token) return { ok: false, message: 'Token kosong.' };
    try {
      const res = await fetch('https://api.fonnte.com/get-devices', {
        method: 'POST',
        // SEC-201: jangan ikuti redirect (anti-SSRF via open redirect).
        redirect: 'manual',
        headers: { Authorization: token },
      });
      const text = await res.text();
      // Fonnte mengembalikan JSON; token salah → "unknown user".
      if (res.ok && !/unknown user/i.test(text)) {
        return { ok: true, message: 'Token valid — terhubung ke Fonnte.' };
      }
      return { ok: false, message: `Fonnte menolak token (HTTP ${res.status}). Periksa kembali token di dashboard Fonnte.` };
    } catch (err) {
      return { ok: false, message: `Gagal menghubungi Fonnte: ${err instanceof Error ? err.message : err}` };
    }
  }
}
