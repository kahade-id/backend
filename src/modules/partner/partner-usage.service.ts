// GAP-F (G461): daily per-endpoint usage aggregation + admin summary.
// Redis increments feed the quota guard; this service persists the daily rows
// (PartnerApiUsage) for the admin dashboard. Writes are best-effort.

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

interface UsagePrisma {
  partnerApiUsage: {
    upsert(args: unknown): Promise<unknown>;
    findMany(args?: unknown): Promise<Array<Record<string, unknown>>>;
  };
  apiClient: {
    findUnique(args: unknown): Promise<Record<string, unknown> | null>;
  };
}

@Injectable()
export class PartnerUsageService {
  private readonly logger = new Logger(PartnerUsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  private get p(): UsagePrisma {
    return this.prisma as unknown as UsagePrisma;
  }

  private dayKey(date = new Date()): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /** Record one API call (fire-and-forget from interceptor). */
  async recordCall(clientId: string, endpoint: string, ok: boolean): Promise<void> {
    try {
      const date = this.dayKey();
      await this.p.partnerApiUsage.upsert({
        where: { clientId_date_endpoint: { clientId, date, endpoint } },
        create: { clientId, date, endpoint, count: 1, errorCount: ok ? 0 : 1 },
        update: {
          count: { increment: 1 },
          errorCount: ok ? undefined : { increment: 1 },
        },
      });
    } catch (err) {
      this.logger.warn(`recordCall failed (best-effort): ${(err as Error).message}`);
    }
  }

  /** Admin summary (G457/G461): per-endpoint totals for a client over N days. */
  async summary(clientId: string, days = 7): Promise<unknown> {
    const client = await this.p.apiClient.findUnique({ where: { id: clientId } });
    if (!client) return null;
    const since = this.dayKey(new Date(Date.now() - (days - 1) * 86400000));
    const rows = await this.p.partnerApiUsage.findMany({
      where: { clientId, date: { gte: since } },
      orderBy: [{ date: 'desc' }, { count: 'desc' }],
      take: 500,
    });
    const totals = rows.reduce(
      (acc: { calls: number; errors: number }, r) => {
        acc.calls += Number(r['count'] ?? 0);
        acc.errors += Number(r['errorCount'] ?? 0);
        return acc;
      },
      { calls: 0, errors: 0 },
    );
    const today = this.dayKey();
    const todayCalls = rows
      .filter((r) => (r['date'] as Date).getTime() === today.getTime())
      .reduce((n, r) => n + Number(r['count'] ?? 0), 0);
    return {
      clientId,
      orgName: client['orgName'],
      quotaPerDay: client['quotaPerDay'],
      todayCalls,
      quotaUsedPct: client['quotaPerDay'] ? Math.round((todayCalls / Number(client['quotaPerDay'])) * 100) : 0,
      totals,
      byEndpoint: rows,
    };
  }
}
