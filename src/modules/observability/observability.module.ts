/**
 * Kahade — modul observability (G476–G500, Grup F worker D).
 *
 * Menyediakan (tanpa vendor lock-in):
 *   - MetricsService + MetricsInterceptor (latency/error per route, G482)
 *   - ErrorSpikeTracker (sinyal alert login/OTP, G485)
 *   - AlertsService (deteksi + pengiriman alert + alert log, G485/G486/G492)
 *   - QueueMetricsService (backlog Bull, G484)
 *   - DependenciesService (status dependensi, G488)
 *   - SyntheticService (cek read-only eksternal, G489)
 *   - DeliveryMetricsService (push/email/OTP, G494)
 *   - WsMetricsService (koneksi WebSocket, G493)
 *   - ObservabilityController (/v1/admin/observability — kontrol akses G499)
 *   - IncidentsController (kelola insiden status publik, G497)
 *   - StatusController (GET /v1/status publik, G497)
 *
 * WsMetricsService & DeliveryMetricsService diekspor agar modul realtime,
 * push, email, dan otp-gateway bisa mencatat tanpa dependensi sirkular
 * (observability tidak mengimpor mereka).
 */
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { QueueModule } from '../queue/queue.module';
import { ObservabilityController } from './observability.controller';
import { IncidentsController } from './incidents.controller';
import { StatusController } from './status.controller';
import { MetricsService, ErrorSpikeTracker } from './metrics.service';
import { MetricsInterceptor } from './metrics.interceptor';
import { AlertsService } from './alerts.service';
import { QueueMetricsService } from './queue-metrics.service';
import { DependenciesService } from './dependencies.service';
import { SyntheticService } from './synthetic.service';
import { DeliveryMetricsService } from './delivery-metrics.service';
import { WsMetricsService } from './ws-metrics.service';

@Module({
  imports: [QueueModule],
  controllers: [ObservabilityController, IncidentsController, StatusController],
  providers: [
    MetricsService,
    ErrorSpikeTracker,
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    AlertsService,
    QueueMetricsService,
    DependenciesService,
    SyntheticService,
    DeliveryMetricsService,
    WsMetricsService,
  ],
  exports: [MetricsService, ErrorSpikeTracker, DeliveryMetricsService, WsMetricsService, AlertsService, SyntheticService, DependenciesService],
})
export class ObservabilityModule {}
