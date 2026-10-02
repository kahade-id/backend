import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditAction, ReconciliationFindingStatus, Prisma } from '@prisma/client';
import { toIdr, toSen, formatIdr } from '../../../common/utils/currency.util';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import {
  FindingsQueryDto,
  AcknowledgeFindingDto,
} from './dto/finance-findings.dto';
import type { WalletDiscrepancy } from './reconciliation.service';

/**
 * E3 (G326-G350) — temuan rekonsiliasi keuangan.
 *
 * Setiap selisih hasil reconcileUser / reconcile-all disimpan sebagai
 * ReconciliationFinding dengan dedup: tidak ada dua temuan yang belum
 * selesai (NEW/INVESTIGATING) untuk user yang sama.
 *
 * Ambang URGENT: bila |difference| > RECONCILIATION_URGENT_THRESHOLD_IDR,
 * temuan ditandai marker URGENT_AMOUNT_THRESHOLD di violatedInvariants,
 * alert Redis `cron_alert:reconciliation_urgent` dinaikkan (terlihat di
 * /health/alerts untuk peran finance), dan audit mencatat urgensi.
 */
export const RECONCILIATION_URGENT_THRESHOLD_IDR = 5_000_000;
export const URGENT_INVARIANT = 'URGENT_AMOUNT_THRESHOLD';

/**
 * BAD-020: builder filter findings yang dipakai BERSAMA oleh list
 * (listFindings) dan ekspor CSV (buildFindingsCsvExport) — ekspor WAJIB
 * menghormati filter aktif yang sama dengan daftar yang dilihat admin.
 */
export function buildFindingsWhereInput(
  query: Pick<FindingsQueryDto, 'status' | 'minDifferenceIdr' | 'maxAgeDays' | 'invariant' | 'urgentOnly'>,
): Prisma.ReconciliationFindingWhereInput {
  const { status, minDifferenceIdr, maxAgeDays, invariant, urgentOnly } = query;
  const where: Prisma.ReconciliationFindingWhereInput = {};
  if (status) where.status = status;
  if (minDifferenceIdr !== undefined && minDifferenceIdr > 0) {
    const bound = toSen(minDifferenceIdr);
    where.OR = [{ difference: { gte: bound } }, { difference: { lte: -bound } }];
  }
  if (maxAgeDays !== undefined && maxAgeDays >= 0) {
    where.createdAt = { gte: new Date(Date.now() - maxAgeDays * 24 * 3600 * 1000) };
  }
  if (invariant) {
    where.violatedInvariants = { has: invariant };
  } else if (urgentOnly) {
    where.violatedInvariants = { has: URGENT_INVARIANT };
  }
  return where;
}
export const LEDGER_MISMATCH_INVARIANT = 'LEDGER_TOTAL_MISMATCH';
export const COMPONENT_MISMATCH_INVARIANT = 'COMPONENT_SUM_MISMATCH';

const UNRESOLVED_STATUSES: ReconciliationFindingStatus[] = ['NEW', 'INVESTIGATING'];

/**
 * Konversi Rupiah (number, bisa negatif) menjadi sen (bigint) dengan
 * mempertahankan tanda. toSen() hanya menerima nilai non-negatif, sehingga
 * selisih negatif (computed < recorded) harus dibungkus helper ini agar
 * tidak melempar RangeError.
 */
export function signedToSen(rupiah: number): bigint {
  if (!Number.isFinite(rupiah)) {
    throw new RangeError('signedToSen expects a finite number');
  }
  return rupiah < 0 ? -toSen(Math.abs(rupiah)) : toSen(rupiah);
}

export interface FindingView {
  id: string;
  userId: string;
  recordedBalanceIdr: number;
  computedBalanceIdr: number;
  differenceIdr: number;
  urgent: boolean;
  violatedInvariants: string[];
  status: ReconciliationFindingStatus;
  batchId: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  notes: string | null;
  ageDays: number;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class ReconciliationFindingsService {
  private readonly logger = new Logger(ReconciliationFindingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Simpan temuan dari hasil rekonsiliasi. Dedup: lewati user yang sudah
   * punya temuan NEW/INVESTIGATING (belum resolved).
   * Mengembalikan temuan yang benar-benar dibuat.
   *
   * B1-010 (perf): dedup dalam SATU findMany + SATU createManyAndReturn —
   * bukan read-then-write per temuan (N+1 + race window duplikat antar proses).
   * Dedup intra-batch (user yang sama muncul 2x) dipertahankan: hanya yang
   * pertama dibuat, seperti perilaku loop lama.
   */
  async recordFromDiscrepancies(
    discrepancies: WalletDiscrepancy[],
    batchId: string | null,
    requestedBy: string,
  ): Promise<FindingView[]> {
    if (discrepancies.length === 0) return [];

    const userIds = [...new Set(discrepancies.map((d) => d.userId))];
    const unresolved = await this.prisma.reconciliationFinding.findMany({
      where: { userId: { in: userIds }, status: { in: UNRESOLVED_STATUSES } },
      select: { userId: true },
    });
    const hasUnresolved = new Set(unresolved.map((r) => r.userId));

    const seenInBatch = new Set<string>();
    const prepared = discrepancies
      .filter((d) => {
        if (hasUnresolved.has(d.userId) || seenInBatch.has(d.userId)) {
          this.logger.debug(`Skipping duplicate finding for user ${d.userId}`);
          return false;
        }
        seenInBatch.add(d.userId);
        return true;
      })
      .map((d) => {
        const differenceSen = toSen(Math.abs(d.discrepancy));
        const urgent =
          d.discrepancy !== 0 && differenceSen > toSen(RECONCILIATION_URGENT_THRESHOLD_IDR);
        const violatedInvariants: string[] = [];
        if (d.discrepancy !== 0) violatedInvariants.push(LEDGER_MISMATCH_INVARIANT);
        if (d.invariantViolation) violatedInvariants.push(COMPONENT_MISMATCH_INVARIANT);
        if (urgent) violatedInvariants.push(URGENT_INVARIANT);
        return {
          userId: d.userId,
          discrepancy: d.discrepancy,
          urgent,
          data: {
            userId: d.userId,
            recordedBalance: signedToSen(d.actualTotal),
            computedBalance: signedToSen(d.expectedTotal),
            difference: signedToSen(d.discrepancy),
            violatedInvariants,
            batchId,
          },
        };
      });
    if (prepared.length === 0) return [];

    const rows = await this.prisma.reconciliationFinding.createManyAndReturn({
      data: prepared.map((p) => p.data),
    });
    const rowByUserId = new Map(rows.map((r) => [r.userId, r]));

    const created: FindingView[] = [];
    const urgentAlerts: Promise<void>[] = [];
    for (const p of prepared) {
      const row = rowByUserId.get(p.userId);
      if (!row) continue;

      this.auditLog.logAdminAction({
        adminId: requestedBy,
        action: AuditAction.RECONCILIATION_FINDING_CREATED,
        targetType: 'ReconciliationFinding',
        targetId: row.id,
        description:
          `Reconciliation finding for user ${p.userId}: difference ${formatIdr(p.discrepancy)}` +
          (p.urgent ? ' [URGENT]' : ''),
        after: {
          userId: p.userId,
          differenceIdr: p.discrepancy,
          urgent: p.urgent,
          batchId,
          violatedInvariants: row.violatedInvariants,
        },
        ipAddress: 'internal',
      });

      if (p.urgent) {
        urgentAlerts.push(this.raiseUrgentAlert(row.id, p.userId, p.discrepancy));
      }
      created.push(this.toView(row));
    }
    await Promise.all(urgentAlerts);
    return created;
  }

  private async raiseUrgentAlert(findingId: string, userId: string, differenceIdr: number): Promise<void> {
    try {
      await this.redis.setex(
        'cron_alert:reconciliation_urgent',
        24 * 3600,
        JSON.stringify({
          raisedAt: new Date().toISOString(),
          findingId,
          // Tanpa PII: hanya userId internal + nominal selisih.
          userId,
          differenceIdr,
        }),
      );
    } catch (err) {
      this.logger.warn(`Failed to raise reconciliation urgent alert: ${(err as Error).message}`);
    }
  }

  async listFindings(query: FindingsQueryDto): Promise<object> {
    const { page = 1, limit = 20 } = query;
    const safePage = Number.isInteger(page) && page > 0 ? page : 1;
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;

    // BAD-020: filter yang sama dipakai ekspor CSV.
    const where = buildFindingsWhereInput(query);

    const [rows, total] = await Promise.all([
      this.prisma.reconciliationFinding.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.reconciliationFinding.count({ where }),
    ]);

    return createPaginatedResponse(rows.map((r) => this.toView(r)), total, safePage, safeLimit);
  }

  async listByBatch(batchId: string, page = 1, limit = 20): Promise<object> {
    const safePage = Number.isInteger(page) && page > 0 ? page : 1;
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
    const where: Prisma.ReconciliationFindingWhereInput = { batchId };
    const [rows, total] = await Promise.all([
      this.prisma.reconciliationFinding.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.reconciliationFinding.count({ where }),
    ]);
    return createPaginatedResponse(rows.map((r) => this.toView(r)), total, safePage, safeLimit);
  }

  async acknowledgeFinding(
    id: string,
    adminId: string,
    dto: AcknowledgeFindingDto,
    ipAddress: string,
  ): Promise<FindingView> {
    const row = await this.prisma.reconciliationFinding.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Reconciliation finding not found' });
    }

    // ADM-228: temuan yang sudah RESOLVED/ACCEPTED boleh dibuka kembali ke
    // INVESTIGATING (catatan wajib — divalidasi di bawah), agar salah tandai
    // selesai tidak permanen. Reopen dicatat dengan aksi audit spesifik.
    const allowed: Record<ReconciliationFindingStatus, ReconciliationFindingStatus[]> = {
      NEW: ['INVESTIGATING', 'RESOLVED', 'ACCEPTED'],
      INVESTIGATING: ['RESOLVED', 'ACCEPTED'],
      RESOLVED: ['INVESTIGATING'],
      ACCEPTED: ['INVESTIGATING'],
    };
    if (!allowed[row.status].includes(dto.status)) {
      throw new ConflictException({
        code: 'INVALID_FINDING_TRANSITION',
        message: `Cannot transition finding from ${row.status} to ${dto.status}`,
      });
    }
    if (dto.status === 'INVESTIGATING' && !dto.notes?.trim()) {
      throw new BadRequestException({
        code: 'NOTES_REQUIRED',
        message: 'Catatan wajib diisi saat temuan mulai diinvestigasi',
      });
    }

    const updated = await this.prisma.reconciliationFinding.update({
      where: { id },
      data: {
        status: dto.status,
        acknowledgedBy: adminId,
        acknowledgedAt: new Date(),
        notes: dto.notes?.trim() ? dto.notes.trim() : row.notes,
      },
    });

    const isReopen = dto.status === 'INVESTIGATING' && (row.status === 'RESOLVED' || row.status === 'ACCEPTED');

    this.auditLog.logAdminAction({
      adminId,
      action: isReopen
        ? AuditAction.RECONCILIATION_FINDING_REOPENED
        : AuditAction.RECONCILIATION_FINDING_ACKNOWLEDGED,
      targetType: 'ReconciliationFinding',
      targetId: id,
      description: `Finding ${id} ${isReopen ? 'reopened' : 'acknowledged'} → ${dto.status}${dto.notes ? `: ${dto.notes.slice(0, 200)}` : ''}`,
      before: { status: row.status },
      after: { status: dto.status },
      ipAddress,
    });

    return this.toView(updated);
  }

  private toView(row: {
    id: string;
    userId: string;
    recordedBalance: bigint;
    computedBalance: bigint;
    difference: bigint;
    violatedInvariants: string[];
    status: ReconciliationFindingStatus;
    batchId: string | null;
    acknowledgedBy: string | null;
    acknowledgedAt: Date | null;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): FindingView {
    return {
      id: row.id,
      userId: row.userId,
      recordedBalanceIdr: toIdr(row.recordedBalance),
      computedBalanceIdr: toIdr(row.computedBalance),
      differenceIdr: toIdr(row.difference),
      urgent: row.violatedInvariants.includes(URGENT_INVARIANT),
      violatedInvariants: row.violatedInvariants,
      status: row.status,
      batchId: row.batchId,
      acknowledgedBy: row.acknowledgedBy,
      acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
      notes: row.notes,
      ageDays: Math.floor((Date.now() - row.createdAt.getTime()) / (24 * 3600 * 1000)),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
