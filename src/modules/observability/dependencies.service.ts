/**
 * Kahade — status dependensi untuk observability (G488 audit 2026-09-26).
 *
 * Melengkapi `GET /v1/health` (yang memakai Terminus indicator boolean)
 * dengan rincian per dependensi: ok / degraded / down + latency, khusus
 * untuk halaman admin observability:
 *   - redis, postgresql (SELECT 1), storage disk (ruang bebas),
 *   - otp_provider: status KONFIGURASI (bukan kredensial!) — provider mana
 *     yang terkonfigurasi (fonnte/twilio/mock), token diset atau tidak
 *     (boolean saja, nilai tidak pernah diekspos),
 *   - payment_provider: Midtrans — server key terkonfigurasi? (boolean),
 *     tanpa memanggil API berbayar (probe jaringan milik health check).
 *
 * "degraded" dipakai untuk kondisi terkonfigurasi-tapi-lambat atau
 * provider mock di production (fungsional tapi tidak nyata).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { OpsSettingsService } from '../ops-settings/ops-settings.service';

export type DependencyStatus = 'ok' | 'degraded' | 'down';

export interface DependencyInfo {
  name: string;
  status: DependencyStatus;
  latencyMs: number | null;
  /** Detail aman — TIDAK PERNAH berisi secret/kredensial. */
  detail: Record<string, string | number | boolean>;
}

@Injectable()
export class DependenciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly opsSettings: OpsSettingsService,
  ) {}

  async getStatuses(): Promise<DependencyInfo[]> {
    const [redis, postgres, disk, otp, payment] = await Promise.all([
      this.checkRedis(),
      this.checkPostgres(),
      this.checkDisk(),
      this.checkOtpProvider(),
      this.checkPaymentProvider(),
    ]);
    return [redis, postgres, disk, otp, payment];
  }

  private async checkRedis(): Promise<DependencyInfo> {
    const started = Date.now();
    try {
      const pong = await this.redis.getClient().ping();
      const latencyMs = Date.now() - started;
      return {
        name: 'redis', latencyMs,
        status: pong === 'PONG' ? (latencyMs > 500 ? 'degraded' : 'ok') : 'down',
        detail: {},
      };
    } catch {
      return { name: 'redis', status: 'down', latencyMs: null, detail: {} };
    }
  }

  private async checkPostgres(): Promise<DependencyInfo> {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const latencyMs = Date.now() - started;
      return {
        name: 'postgresql', latencyMs,
        status: latencyMs > 1000 ? 'degraded' : 'ok',
        detail: {},
      };
    } catch {
      return { name: 'postgresql', status: 'down', latencyMs: null, detail: {} };
    }
  }

  private checkDisk(): DependencyInfo {
    try {
      const dir = process.env.UPLOAD_DIR || '/var/www/kahade-storage';
      const stats = fs.statfsSync(dir);
      const totalBytes = stats.bsize * stats.blocks;
      const freeBytes = stats.bsize * stats.bavail;
      const usedPercent = Math.round(((totalBytes - freeBytes) / totalBytes) * 100);
      return {
        name: 'storage_disk',
        status: usedPercent >= 90 ? 'down' : usedPercent >= 80 ? 'degraded' : 'ok',
        latencyMs: 0,
        detail: { usedPercent, freeMb: Math.round(freeBytes / 1024 / 1024), dir },
      };
    } catch {
      return { name: 'storage_disk', status: 'down', latencyMs: null, detail: {} };
    }
  }

  private checkOtpProvider(): DependencyInfo {
    const provider = (process.env.OTP_PROVIDER || 'mock').toLowerCase();
    const isProd = (process.env.NODE_ENV || 'development') === 'production';
    const tokenConfigured =
      provider === 'fonnte'
        ? this.opsSettings.has('FONNTE_API_TOKEN')
        : provider === 'twilio'
          ? !!process.env.TWILIO_AUTH_TOKEN
          : true;
    // Hanya boolean konfigurasi — nilai token tidak pernah keluar dari proses.
    const status: DependencyStatus =
      !tokenConfigured || (isProd && provider === 'mock') ? 'down'
      : provider === 'mock' ? 'degraded'
      : 'ok';
    return {
      name: 'otp_provider',
      status,
      latencyMs: null,
      detail: { provider, tokenConfigured, production: isProd },
    };
  }

  private checkPaymentProvider(): DependencyInfo {
    const serverKeyConfigured = !!this.config.get<string>('midtrans.serverKey');
    const isProduction = this.config.get<boolean>('midtrans.isProduction') ?? false;
    return {
      name: 'payment_provider',
      status: serverKeyConfigured ? 'ok' : 'down',
      latencyMs: null,
      // Tanpa probe jaringan di sini (milik health check Terminus); tanpa
      // nilai secret — hanya fakta "terkonfigurasi".
      detail: { provider: 'midtrans', serverKeyConfigured, mode: isProduction ? 'production' : 'sandbox' },
    };
  }
}
