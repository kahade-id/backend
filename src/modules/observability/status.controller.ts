/**
 * Kahade — halaman status publik (G497 audit 2026-09-26).
 *
 * `GET /v1/status` — TANPA auth, throttle ketat. Mengembalikan:
 *   - status keseluruhan: operational | degraded | outage
 *   - komponen + status masing-masing (ringkas, tanpa detail internal)
 *   - histori gangguan dari model IncidentLog (fragment gap-F-D);
 *     bila tabel belum dimigrasi → fallback aman (array kosong), endpoint
 *     tetap 200 — status publik tidak boleh 500 karena migrasi tertunda.
 *
 * Pengelolaan insiden (create/update) ada di ObservabilityController
 * (SUPER_ADMIN). Endpoint ini read-only publik.
 */
import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { DependenciesService } from './dependencies.service';

interface PublicIncident {
  id: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  component: string;
  startedAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}

@Public()
@Controller('status')
@Throttle({ default: { ttl: 60_000, limit: 20 } })
export class StatusController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dependencies: DependenciesService,
  ) {}

  @Get()
  async getStatus(): Promise<{
    status: 'operational' | 'degraded' | 'outage';
    release: string;
    at: string;
    components: Array<{ name: string; status: 'operational' | 'degraded' | 'outage' }>;
    activeIncidents: PublicIncident[];
    history: PublicIncident[];
  }> {
    const deps = await this.dependencies.getStatuses().catch(() => []);
    const components = deps.map((d) => ({
      name: componentLabel(d.name),
      status: d.status === 'ok' ? 'operational' as const : d.status === 'degraded' ? 'degraded' as const : 'outage' as const,
    }));
    const incidents = await this.readIncidents().catch(() => []);
    const active = incidents.filter((i) => i.status !== 'RESOLVED');

    const worst = (list: Array<'operational' | 'degraded' | 'outage'>): 'operational' | 'degraded' | 'outage' =>
      list.includes('outage') ? 'outage' : list.includes('degraded') ? 'degraded' : 'operational';
    const status = worst([
      ...components.map((c) => c.status),
      ...active.map(() => 'degraded' as const),
    ]);

    return {
      status,
      release: process.env.RELEASE_SHA || process.env.APP_VERSION || 'unknown',
      at: new Date().toISOString(),
      components,
      activeIncidents: active,
      history: incidents.filter((i) => i.status === 'RESOLVED').slice(0, 20),
    };
  }

  private async readIncidents(): Promise<PublicIncident[]> {
    const rows = await (this.prisma as unknown as {
      incidentLog: {
        findMany: (args: unknown) => Promise<Array<{
          id: string; title: string; description: string; severity: string;
          status: string; component: string; startedAt: Date; resolvedAt: Date | null;
          updatedAt: Date;
        }>>;
      };
    }).incidentLog.findMany({
      orderBy: { startedAt: 'desc' },
      take: 30,
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      // Deskripsi insiden ditulis untuk publik — service memastikan
      // tidak ada PII saat create/update.
      description: r.description,
      severity: r.severity,
      status: r.status,
      component: r.component,
      startedAt: r.startedAt.toISOString(),
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }
}

function componentLabel(name: string): string {
  const labels: Record<string, string> = {
    redis: 'Cache',
    postgresql: 'Database',
    storage_disk: 'Penyimpanan file',
    otp_provider: 'OTP WhatsApp',
    payment_provider: 'Pembayaran',
  };
  return labels[name] ?? name;
}
