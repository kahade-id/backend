/**
 * Kahade — mesin deteksi & pengiriman alert operasional (G485/G486/G492).
 *
 * Pola "notifikasi admin" mengikuti konvensi yang sudah ada
 * (daily-reconciliation.service.ts `alertAdminsOnMismatch`):
 *   1. Baris `AdminAuditLog` ber-prefix `[SYSTEM ALERT]` untuk tiap
 *      SUPER_ADMIN aktif (permukaan yang dibaca halaman admin),
 *   2. `logger.error` agar tertangkap log aggregator / Sentry backend,
 *   3. Baris `AlertEvent` (model baru, fragment gap-F-D) sebagai alert log
 *      persisten dengan lifecycle raised → acknowledged/resolved,
 *   4. Opsional: POST fire-and-forget ke `OPS_ALERT_WEBHOOK_URL` (paging
 *      eksternal, mis. PagerDuty/Opsgenie webhook) — TANPA secret di payload.
 *
 * Anti-storm: tiap kunci alert punya cooldown (default 30 menit). Alert yang
 * masih dalam cooldown tidak dikirim ulang, tetapi `lastSeenAt` diperbarui.
 * Dijalankan berkala via @Interval 60 detik + bisa dipicu manual dari
 * endpoint admin (dan test sintetis G500).
 *
 * Aturan yang dievaluasi:
 *   G485 login_errors   : >50 kegagalan login / 5 menit
 *   G485 otp_errors     : >50 kegagalan OTP / 5 menit
 *   G486 payment_pending: rasio transaksi PENDING > 20% dalam 1 jam terakhir
 *                         (min. 20 transaksi — anti-noise saat sepi)
 *   G486 webhook_retry  : >100 webhook MIDTRANS belum terproses & siap retry
 *   G486 dlq_depth      : >50 job di dead-letter queue
 *   G492 disk_usage     : partisi / dipakai ≥80%
 *   G492 table_growth   : webhook_log / audit_log / admin_audit_log > 5 GB
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import * as fs from 'fs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction } from '@prisma/client';
import { ErrorSpikeTracker } from './metrics.service';
import { DEAD_LETTER_QUEUE } from '../queue/queue.constants';

export type AlertSeverity = 'warning' | 'critical';

export interface AlertRuleResult {
  key: string;
  severity: AlertSeverity;
  message: string;
  /** Angka diagnostik aman (tanpa PII). */
  context: Record<string, number | string | boolean>;
}

const FIVE_MIN = 5 * 60 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000;
const SPIKE_THRESHOLD = 50;

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  /** key → kapan cooldown berakhir (epoch ms). */
  private readonly cooldowns = new Map<string, number>();
  /** key → kapan terakhir terlihat aktif (untuk auto-resolve ringan). */
  private readonly lastSeen = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly spikes: ErrorSpikeTracker,
    @Optional() @InjectQueue(DEAD_LETTER_QUEUE) private readonly dlq?: Queue,
  ) {}

  /** Evaluasi berkala — interval 60 detik (dilewati saat modul tak termuat). */
  @Interval(60_000)
  async evaluateScheduled(): Promise<void> {
    try {
      await this.evaluateAll();
    } catch (err) {
      this.logger.error(`Alert evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Jalankan semua aturan; yang terpicu → raise (dengan cooldown). */
  async evaluateAll(): Promise<AlertRuleResult[]> {
    const results: AlertRuleResult[] = [];
    const checks: Array<() => Promise<AlertRuleResult | null>> = [
      () => this.checkLoginSpike(),
      () => this.checkOtpSpike(),
      () => this.checkPaymentPendingRatio(),
      () => this.checkWebhookRetryDepth(),
      () => this.checkDlqDepth(),
      () => this.checkDiskUsage(),
      () => this.checkTableGrowth(),
    ];
    for (const check of checks) {
      try {
        const hit = await check();
        if (hit) {
          results.push(hit);
          await this.raise(hit);
        }
      } catch (err) {
        this.logger.warn(`Alert rule failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return results;
  }

  // ---------------------------------------------------------------- aturan

  private async checkLoginSpike(): Promise<AlertRuleResult | null> {
    const count = this.spikes.countSince('login', FIVE_MIN);
    if (count <= SPIKE_THRESHOLD) return null;
    return {
      key: 'login_errors',
      severity: 'critical',
      message: `Lonjakan kegagalan login: ${count} dalam 5 menit (threshold ${SPIKE_THRESHOLD})`,
      context: { count, windowMinutes: 5, threshold: SPIKE_THRESHOLD },
    };
  }

  private async checkOtpSpike(): Promise<AlertRuleResult | null> {
    const count = this.spikes.countSince('otp', FIVE_MIN);
    if (count <= SPIKE_THRESHOLD) return null;
    return {
      key: 'otp_errors',
      severity: 'critical',
      message: `Lonjakan kegagalan OTP: ${count} dalam 5 menit (threshold ${SPIKE_THRESHOLD})`,
      context: { count, windowMinutes: 5, threshold: SPIKE_THRESHOLD },
    };
  }

  private async checkPaymentPendingRatio(): Promise<AlertRuleResult | null> {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const rows = await this.prisma.paymentTransaction.groupBy({
      by: ['status'],
      where: { createdAt: { gte: since } },
      _count: { status: true },
    });
    let pending = 0;
    let total = 0;
    for (const row of rows) {
      const n = row._count.status;
      total += n;
      if (row.status === 'PENDING') pending += n;
    }
    if (total < 20) return null;
    const ratio = pending / total;
    if (ratio <= 0.2) return null;
    return {
      key: 'payment_pending',
      severity: ratio > 0.5 ? 'critical' : 'warning',
      message: `Rasio transaksi PENDING tinggi: ${Math.round(ratio * 100)}% (${pending}/${total}) dalam 1 jam terakhir`,
      context: { pending, total, ratio: Math.round(ratio * 1000) / 1000, windowHours: 1 },
    };
  }

  private async checkWebhookRetryDepth(): Promise<AlertRuleResult | null> {
    const now = new Date();
    const retryable = await this.prisma.webhookLog.count({
      where: {
        source: 'MIDTRANS',
        isProcessed: false,
        deadLetteredAt: null,
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
      },
    });
    if (retryable <= 100) return null;
    return {
      key: 'webhook_retry',
      severity: retryable > 500 ? 'critical' : 'warning',
      message: `Antrean retry webhook menumpuk: ${retryable} webhook MIDTRANS belum terproses`,
      context: { retryable, threshold: 100 },
    };
  }

  private async checkDlqDepth(): Promise<AlertRuleResult | null> {
    if (!this.dlq) return null;
    const counts = await this.dlq.getJobCounts();
    const depth = Object.values(counts).reduce<number>(
      (total, n) => total + (typeof n === 'number' ? n : 0), 0,
    );
    if (depth <= 50) return null;
    return {
      key: 'dlq_depth',
      severity: depth > 200 ? 'critical' : 'warning',
      message: `Dead-letter queue dalam: ${depth} job (threshold 50)`,
      context: { depth, threshold: 50 },
    };
  }

  private async checkDiskUsage(): Promise<AlertRuleResult | null> {
    try {
      const stats = fs.statfsSync('/');
      const totalBytes = stats.bsize * stats.blocks;
      const freeBytes = stats.bsize * stats.bavail;
      const usedPercent = Math.round(((totalBytes - freeBytes) / totalBytes) * 100);
      if (usedPercent < 80) return null;
      return {
        key: 'disk_usage',
        severity: usedPercent >= 90 ? 'critical' : 'warning',
        message: `Penggunaan disk ${usedPercent}% (threshold 80%) — risiko storage penuh`,
        context: { usedPercent, freeMb: Math.round(freeBytes / 1024 / 1024), threshold: 80 },
      };
    } catch {
      return null;
    }
  }

  private async checkTableGrowth(): Promise<AlertRuleResult | null> {
    // pg_total_relation_size mencakup tabel + index + TOAST — angka kasar
    // yang tepat untuk peringatan kapasitas, bukan untuk audit presisi.
    const rows = await this.prisma.$queryRaw<Array<{ relname: string; bytes: bigint }>>`
      SELECT relname, pg_total_relation_size(oid) AS bytes
      FROM pg_class
      WHERE relname IN ('webhook_log', 'audit_log', 'admin_audit_log', 'notification_log')
    `;
    const FIVE_GB = 5 * 1024 * 1024 * 1024;
    const over = rows.filter((r) => Number(r.bytes) > FIVE_GB);
    if (over.length === 0) return null;
    const detail = over.map((r) => `${r.relname}=${(Number(r.bytes) / 1024 ** 3).toFixed(1)}GB`).join(',');
    return {
      key: 'table_growth',
      severity: 'warning',
      message: `Tabel log tumbuh besar: ${detail} (threshold 5GB) — jadwalkan archival/purge`,
      context: { tables: detail, thresholdGb: 5 },
    };
  }

  // ---------------------------------------------------------------- raise

  /**
   * Kirim alert dengan cooldown anti-storm. Mengembalikan true bila alert
   * benar-benar dikirim (bukan di-suppress cooldown).
   */
  async raise(hit: AlertRuleResult): Promise<boolean> {
    const now = Date.now();
    this.lastSeen.set(hit.key, now);
    const cooldownUntil = this.cooldowns.get(hit.key) ?? 0;
    if (now < cooldownUntil) return false;
    this.cooldowns.set(hit.key, now + COOLDOWN_MS);

    this.logger.error(`[ALERT:${hit.severity.toUpperCase()}] ${hit.key} — ${hit.message}`);

    // 1. Alert log persisten (model AlertEvent — fragment gap-F-D).
    //    Best-effort: alert tidak boleh gagal hanya karena tabel belum
    //    dimigrasi (mis. smoke test tanpa migrasi baru).
    try {
      await (this.prisma as unknown as {
        alertEvent: {
          upsert: (args: unknown) => Promise<unknown>;
        };
      }).alertEvent.upsert({
        where: { key: hit.key },
        update: {
          severity: hit.severity,
          message: hit.message,
          context: hit.context as unknown as Record<string, unknown>,
          status: 'RAISED',
          lastSeenAt: new Date(),
          cooldownUntil: new Date(now + COOLDOWN_MS),
        },
        create: {
          key: hit.key,
          severity: hit.severity,
          message: hit.message,
          context: hit.context as unknown as Record<string, unknown>,
          status: 'RAISED',
          lastSeenAt: new Date(),
          cooldownUntil: new Date(now + COOLDOWN_MS),
        },
      });
    } catch (err) {
      this.logger.warn(`AlertEvent persist skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Notifikasi admin (konvensi: AdminAuditLog [SYSTEM ALERT]).
    try {
      const admins = await this.prisma.adminUser.findMany({
        where: { isActive: true, deletedAt: null, role: 'SUPER_ADMIN' },
        select: { id: true },
        take: 5,
      });
      const targets = admins.length > 0
        ? admins
        : await this.prisma.adminUser.findMany({
            where: { isActive: true, deletedAt: null },
            select: { id: true },
            take: 1,
          });
      for (const admin of targets) {
        await this.prisma.adminAuditLog.create({
          data: {
            adminId: admin.id,
            action: AuditAction.ADMIN_ACTION,
            targetType: 'ObservabilityAlert',
            targetId: hit.key,
            description: `[SYSTEM ALERT][${hit.severity.toUpperCase()}] ${hit.message}`,
            ipAddress: 'system',
          },
        }).catch((err: unknown) =>
          this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    } catch (err) {
      this.logger.warn(`Admin alert notify failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Webhook paging eksternal (opsional, fire-and-forget, tanpa secret).
    const hookUrl = process.env.OPS_ALERT_WEBHOOK_URL;
    if (hookUrl && /^https:\/\//.test(hookUrl)) {
      void fetch(hookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: hit.key,
          severity: hit.severity,
          message: hit.message,
          context: hit.context,
          service: 'kahade-backend',
          release: process.env.RELEASE_SHA || process.env.APP_VERSION || 'unknown',
          at: new Date().toISOString(),
        }),
      }).catch(() => undefined);
    }
    return true;
  }

  /**
   * Tandai alert selesai (dipakai halaman admin + test G500).
   * Idempoten: memanggil dua kali tidak error.
   */
  async resolve(key: string, resolvedBy: string): Promise<boolean> {
    this.cooldowns.delete(key);
    this.lastSeen.delete(key);
    try {
      const updated = await (this.prisma as unknown as {
        alertEvent: { updateMany: (args: unknown) => Promise<{ count: number }> };
      }).alertEvent.updateMany({
        where: { key, status: { in: ['RAISED', 'ACKNOWLEDGED'] } },
        data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedBy },
      });
      return updated.count > 0;
    } catch {
      return false;
    }
  }

  /** Daftar alert aktif (untuk endpoint admin + halaman observability). */
  async listActive(): Promise<Array<Record<string, unknown>>> {
    try {
      const rows = await (this.prisma as unknown as {
        alertEvent: {
          findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
        };
      }).alertEvent.findMany({
        where: { status: { in: ['RAISED', 'ACKNOWLEDGED'] } },
        orderBy: { lastSeenAt: 'desc' },
        take: 100,
      });
      return rows;
    } catch {
      return [];
    }
  }

  /**
   * Pemicu alert SINTETIS end-to-end (G500): trigger → alert log → notifikasi,
   * lalu verifikasi penutupan. Hanya untuk pengujian — di produksi dibatasi
   * SUPER_ADMIN via controller.
   */
  async triggerSyntheticAlert(): Promise<{ raised: boolean; resolved: boolean; key: string }> {
    const key = 'synthetic_test';
    this.cooldowns.delete(key);
    const raised = await this.raise({
      key,
      severity: 'warning',
      message: 'Alert sintetis: uji pipeline alert end-to-end (aman diabaikan)',
      context: { synthetic: true, triggeredAt: new Date().toISOString() },
    });
    const active = await this.listActive();
    const seenInLog = active.some((a) => a['key'] === key);
    const resolved = await this.resolve(key, 'synthetic-test');
    return { raised: raised && seenInLog, resolved, key };
  }
}
