import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditAction } from '@prisma/client';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import {
  slaStatus,
  getEffectiveSlaConfig,
  SLA_SCOPES,
  type SlaConfigLike,
} from '../../admin/kyc/sla.util';

/**
 * GAP-E (G279–G281, G295–G296): monitor SLA operasional antrean KYC &
 * verifikasi bisnis.
 *
 * Tiap 15 menit:
 * - backfill slaStartedAt = createdAt untuk item PENDING lama (dibuat sebelum
 *   field SLA ada),
 * - tandai slaBreachedAt untuk item yang lewat SLA,
 * - kirim peringatan sekali per 24 jam untuk item yang mendekati SLA.
 *
 * Kanal alert: belum ada kanal notifikasi in-app untuk admin (Notification
 * hanya untuk user), jadi alert ditulis ke admin audit log ([SYSTEM]) +
 * logger [ADMIN ALERT] — pola yang sama dipakai dispute-escalation-sla &
 * daily-reconciliation. Follow-up: tabel notifikasi khusus admin.
 */
@Injectable()
export class KycSlaMonitorService {
  private readonly logger = new Logger(KycSlaMonitorService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  @Cron('*/15 * * * *', { name: 'kyc-sla-monitor' })
  async checkKycSla(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'kyc-sla-monitor'))) return;

    const lockKey = 'cron_lock:kyc_sla_monitor';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 900);
    if (!acquired) return;

    try {
      await this.backfillSlaStartedAt();
      for (const scope of SLA_SCOPES) {
        const config = await getEffectiveSlaConfig(this.prisma, scope);
        if (scope === 'KYC_PERSONAL') {
          await this.markBreaches('kyc', config);
          await this.sendWarnings('kyc', config);
        } else {
          await this.markBreaches('business', config);
          await this.sendWarnings('business', config);
        }
      }
    } catch (error) {
      this.logger.error('KycSlaMonitorService FAILED', error);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch((err) =>
        this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  /** Backfill satu kali: PENDING lama tanpa slaStartedAt ← createdAt. */
  private async backfillSlaStartedAt(): Promise<void> {
    // String SQL statis — tanpa interpolasi nilai luar.
    // (business_verifications tidak punya kolom SLA; SLA-nya dihitung dari createdAt.)
    const kyc = await this.prisma.$executeRawUnsafe(
      `UPDATE "kyc_requests" SET "sla_started_at" = "created_at" WHERE "status" = 'PENDING' AND "sla_started_at" IS NULL`,
    );
    if (Number(kyc) > 0) {
      this.logger.log(`Backfilled slaStartedAt for ${kyc} KYC request(s).`);
    }
  }

  /**
   * Item bisnis memakai createdAt sebagai awal SLA (tidak ada kolom SLA di
   * business_verifications); breach tidak disimpan, hanya di-alert dengan
   * dedup Redis 24 jam.
   */
  private async markBreaches(kind: 'kyc' | 'business', config: SlaConfigLike): Promise<void> {
    const now = new Date();
    const items = kind === 'kyc' ? await this.pendingKyc() : await this.pendingBusiness();
    for (const item of items) {
      try {
        const status = slaStatus(
          {
            slaStartedAt: item.slaStartedAt ?? item.createdAt,
            slaPausedAt: item.slaPausedAt,
            slaPausedAccumMs: item.slaPausedAccumMs,
          },
          now,
          config,
        );
        if (status !== 'BREACHED') continue;

        if (kind === 'business') {
          // Tidak ada kolom slaBreachedAt di business_verifications — alert
          // dengan dedup Redis 24 jam agar tidak spam tiap 15 menit.
          const breachKey = `kyc:sla:breached:business:${item.id}`;
          const alreadyAlerted = await this.redis.get(breachKey).catch(() => null);
          if (alreadyAlerted) continue;
          await this.redis.set(breachKey, '1', 24 * 3600).catch((err: unknown) =>
            this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
          );
          await this.alertAdmin(
            `[SYSTEM] ${item.label} melewati SLA operasional (${config.slaHours} jam ${config.useBusinessHours ? 'kerja' : 'kalender'}) — butuh penanganan prioritas.`,
            'BUSINESS_VERIFICATION',
            item.id,
          );
          this.logger.error(`[ADMIN ALERT] SLA breached: ${item.label}.`);
          continue;
        }

        const marked = await this.prisma.kycRequest.updateMany({
          where: { id: item.id, status: 'PENDING', slaBreachedAt: null },
          data: { slaBreachedAt: now },
        });
        if (marked.count === 0) continue;

        await this.alertAdmin(
          `[SYSTEM] ${item.label} melewati SLA operasional (${config.slaHours} jam ${config.useBusinessHours ? 'kerja' : 'kalender'}) — butuh penanganan prioritas.`,
          'KYC_REQUEST',
          item.id,
        );
        this.logger.error(`[ADMIN ALERT] SLA breached: ${item.label}.`);
      } catch (err: unknown) {
        this.logger.error(
          `Failed to mark SLA breach for ${item.label}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async sendWarnings(kind: 'kyc' | 'business', config: SlaConfigLike): Promise<void> {
    const now = new Date();
    const items = kind === 'kyc' ? await this.pendingKyc() : await this.pendingBusiness();
    for (const item of items) {
      try {
        if (item.slaBreachedAt) continue;
        const status = slaStatus(
          {
            slaStartedAt: item.slaStartedAt ?? item.createdAt,
            slaPausedAt: item.slaPausedAt,
            slaPausedAccumMs: item.slaPausedAccumMs,
          },
          now,
          config,
        );
        if (status !== 'MENDEKATI') continue;

        // Alert maksimal 1x per 24 jam per item selama masih "mendekati".
        const warnKey = `kyc:sla:warned:${kind}:${item.id}`;
        const alreadyWarned = await this.redis.get(warnKey).catch(() => null);
        if (alreadyWarned) continue;
        await this.redis.set(warnKey, '1', 24 * 3600).catch((err: unknown) =>
          this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
        );

        await this.alertAdmin(
          `[SYSTEM] ${item.label} mendekati batas SLA operasional (${config.slaHours} jam ${config.useBusinessHours ? 'kerja' : 'kalender'}) — segera tinjau.`,
          kind === 'kyc' ? 'KYC_REQUEST' : 'BUSINESS_VERIFICATION',
          item.id,
        );
        this.logger.warn(`[ADMIN ALERT] SLA warning: ${item.label}.`);
      } catch (err: unknown) {
        this.logger.error(
          `Failed to send SLA warning for ${item.label}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async pendingKyc() {
    const rows = await this.prisma.kycRequest.findMany({
      where: { status: 'PENDING' },
      select: {
        id: true,
        kycId: true,
        slaStartedAt: true,
        slaPausedAt: true,
        slaPausedAccumMs: true,
        slaBreachedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    return rows.map(r => ({ ...r, label: `KYC ${r.kycId}` }));
  }

  private async pendingBusiness() {
    // business_verifications tidak punya kolom SLA — mulai dari createdAt,
    // tanpa jeda; slaBreachedAt tidak disimpan (null).
    const rows = await this.prisma.businessVerification.findMany({
      where: { status: 'PENDING' },
      select: {
        id: true,
        verificationId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    return rows.map(r => ({
      ...r,
      slaStartedAt: null,
      slaPausedAt: null,
      slaPausedAccumMs: BigInt(0),
      slaBreachedAt: null,
      label: `Verifikasi bisnis ${r.verificationId}`,
    }));
  }

  /**
   * Tulis alert ke admin audit log — kanal yang tersedia untuk admin
   * (Notification hanya untuk user). Diatribusikan ke KYC_ADMIN aktif
   * pertama (fallback SUPER_ADMIN → admin aktif mana pun).
   */
  private async alertAdmin(description: string, targetType: string, targetId: string): Promise<void> {
    const targetAdmin =
      (await this.prisma.adminUser.findFirst({
        where: { role: 'KYC_ADMIN', isActive: true, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })) ??
      (await this.prisma.adminUser.findFirst({
        where: { role: 'SUPER_ADMIN', isActive: true, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })) ??
      (await this.prisma.adminUser.findFirst({
        where: { isActive: true, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      }));
    if (!targetAdmin) {
      this.logger.warn(`[ADMIN ALERT] (no active admin to attribute) ${description}`);
      return;
    }
    await this.prisma.adminAuditLog
      .create({
        data: {
          adminId: targetAdmin.id,
          action: AuditAction.ADMIN_ACTION,
          targetType,
          targetId,
          description,
          ipAddress: 'system',
        },
      })
      .catch((err: unknown) => {
        this.logger.error(
          `Failed audit log for KYC SLA alert: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
}
