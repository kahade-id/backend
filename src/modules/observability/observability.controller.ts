/**
 * Kahade — endpoint observability untuk admin (G482–G486, G492–G494, G499).
 *
 * Kontrol akses (G499):
 *   - Metrik DETAIL (latency per route, queue depth, delivery, ws, storage)
 *     → SUPER_ADMIN saja.
 *   - Status AGREGAT (ringkasan latency, status dependensi, daftar alert,
 *     daftar insiden) → semua role admin (operator).
 *   - Aksi (trigger alert sintetis, resolve alert, kelola insiden) →
 *     SUPER_ADMIN saja.
 *
 * Dokumentasi kontrol akses: docs/runbook-oncall.md § "Akses".
 */
import {
  Body, Controller, Get, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAdminGuard } from '../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { MetricsService } from './metrics.service';
import { QueueMetricsService } from './queue-metrics.service';
import { DependenciesService } from './dependencies.service';
import { DeliveryMetricsService } from './delivery-metrics.service';
import { WsMetricsService } from './ws-metrics.service';
import { AlertsService } from './alerts.service';
import { SyntheticService } from './synthetic.service';
import { getSpanBuffer as getSpans, getSamplingStats as getSampling } from '../../common/tracing/tracing';

const SUPER = 'SUPER_ADMIN' as const;
const ALL_ROLES = ['SUPER_ADMIN', 'DISPUTE_ADMIN', 'KYC_ADMIN', 'FINANCE_ADMIN', 'CUSTOMER_SUPPORT'] as const;

@UseGuards(JwtAdminGuard, AdminRolesGuard)
@Controller('admin/observability')
@Throttle({ default: { ttl: 60_000, limit: 30 } })
export class ObservabilityController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly queues: QueueMetricsService,
    private readonly dependencies: DependenciesService,
    private readonly delivery: DeliveryMetricsService,
    private readonly ws: WsMetricsService,
    private readonly alerts: AlertsService,
    private readonly synthetic: SyntheticService,
  ) {}

  // ------------------------------------------------------------ latency

  /**
   * G483: tabel p95/p99 per route per deployment (dari ring buffer).
   * DETAIL → SUPER_ADMIN.
   */
  @Get('latency')
  @AdminRoles(SUPER)
  getLatency(@Query('route') route?: string) {
    return {
      release: process.env.RELEASE_SHA || process.env.APP_VERSION || 'unknown',
      routes: this.metrics.getRouteStats(route),
    };
  }

  /** Ringkasan agregat untuk operator (tanpa per-route detail). */
  @Get('latency/summary')
  @AdminRoles(...ALL_ROLES)
  getLatencySummary() {
    const routes = this.metrics.getRouteStats();
    const total = routes.reduce((a, r) => a + r.count, 0);
    const errors = routes.reduce((a, r) => a + r.errors, 0);
    const worst = [...routes].sort((a, b) => b.p95 - a.p95).slice(0, 5)
      .map((r) => ({ route: r.route, p95: r.p95, p99: r.p99, count: r.count }));
    return {
      release: process.env.RELEASE_SHA || process.env.APP_VERSION || 'unknown',
      totalRequests: total,
      totalErrors: errors,
      errorRate: total ? errors / total : 0,
      slowestRoutes: worst,
    };
  }

  // ------------------------------------------------------------ spans

  /** Buffer span bisnis (gagal 100% + sampel sukses 1%). DETAIL → SUPER_ADMIN. */
  @Get('spans')
  @AdminRoles(SUPER)
  getSpans() {
    return {
      sampling: getSampling(),
      spans: getSpans().slice(-100),
    };
  }

  // ------------------------------------------------------------ queue

  /** G484: panjang antrean Bull. DETAIL → SUPER_ADMIN. */
  @Get('queues')
  @AdminRoles(SUPER)
  async getQueues() {
    return { queues: await this.queues.getDepths() };
  }

  // ------------------------------------------------------------ dependencies

  /** G488: status dependensi — agregat, boleh dibaca semua role admin. */
  @Get('dependencies')
  @AdminRoles(...ALL_ROLES)
  async getDependencies() {
    return { dependencies: await this.dependencies.getStatuses() };
  }

  // ------------------------------------------------------------ alerts

  /** Daftar alert aktif — semua role admin (operator perlu melihat). */
  @Get('alerts')
  @AdminRoles(...ALL_ROLES)
  async getAlerts() {
    return { alerts: await this.alerts.listActive() };
  }

  /** Evaluasi manual semua aturan (tanpa menunggu interval). */
  @Post('alerts/evaluate')
  @AdminRoles(SUPER)
  async evaluateAlerts() {
    return { triggered: await this.alerts.evaluateAll() };
  }

  /** G500: picu alert sintetis end-to-end (trigger → log → notifikasi → resolve). */
  @Post('alerts/synthetic-test')
  @AdminRoles(SUPER)
  async syntheticAlertTest() {
    return this.alerts.triggerSyntheticAlert();
  }

  /** Tandai alert selesai. */
  @Post('alerts/:key/resolve')
  @AdminRoles(SUPER)
  async resolveAlert(@Param('key') key: string) {
    return { resolved: await this.alerts.resolve(key, 'admin') };
  }

  // ------------------------------------------------------------ delivery

  /** G494: metrik delivery push/email/OTP + status konfigurasi provider OTP. */
  @Get('delivery')
  @AdminRoles(SUPER)
  getDelivery() {
    return {
      stats: this.delivery.getStats(),
      otpProvider: this.delivery.getOtpProviderStatus(),
    };
  }

  // ------------------------------------------------------------ websocket

  /** G493: metrik koneksi WebSocket per worker. DETAIL → SUPER_ADMIN. */
  @Get('websocket')
  @AdminRoles(SUPER)
  getWebsocket() {
    return this.ws.snapshot();
  }

  // ------------------------------------------------------------ storage

  /** G492: ringkasan kapasitas (dipicu ulang on-demand). DETAIL → SUPER_ADMIN. */
  @Get('storage')
  @AdminRoles(SUPER)
  async getStorage() {
    const triggered = await this.alerts.evaluateAll();
    return {
      alerts: triggered.filter((t) => t.key === 'disk_usage' || t.key === 'table_growth'),
      note: 'Detail angka ada di context tiap alert; evaluasi on-demand di atas.',
    };
  }

  // ------------------------------------------------------------ synthetic

  /** Jalankan synthetic check manual (hasil sama dengan /v1/health/synthetic). */
  @Post('synthetic/run')
  @AdminRoles(SUPER)
  async runSynthetic() {
    return this.synthetic.run();
  }
}
