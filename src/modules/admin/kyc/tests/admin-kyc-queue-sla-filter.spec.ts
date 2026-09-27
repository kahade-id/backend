/**
 * ADM-006 — filter `slaStatus` antrean KYC harus EKSAK, bukan aproksimasi SQL.
 *
 * Aproksimasi umur via SQL dapat bertentangan dengan slaStatus() saat mode
 * business-hours / jeda terakumulasi berlaku. Baris yang ditampilkan harus
 * persis berlabel sesuai filter yang dipilih, dan total mencerminkan hasil
 * filter (bukan total pra-filter).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { AdminKycService } from '../admin-kyc.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { RedisService } from '../../../../redis/redis.service';
import { AuditLogService } from '../../../../common/services/audit-log.service';
import { UploadService } from '../../../upload/upload.service';
import { VerificationBadgeService } from '../../../users/verification-badge.service';
import { DashboardService } from '../../dashboard/dashboard.service';
import { EMAIL_QUEUE } from '../../../queue/processors/email.processor';

const HOUR = 3_600_000;
const now = () => Date.now();

/** Kandidat baris KYC dengan berbagai kondisi SLA. */
function row(id: string, kycId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kycId,
    userId: 'user-001',
    status: 'PENDING',
    rejectionReason: null,
    attemptNumber: 1,
    createdAt: new Date(now() - HOUR),
    reviewedAt: null,
    reviewedBy: null,
    slaStartedAt: new Date(now() - HOUR),
    slaPausedAt: null,
    slaPausedAccumMs: BigInt(0),
    slaBreachedAt: null,
    assignedReviewerId: null,
    user: { userId: 'user-001', email: 'a@x.id', fullName: 'A' },
    reviewer: null,
    ...overrides,
  };
}

function buildMocks() {
  const mockPrisma = {
    kycRequest: { findMany: jest.fn(), count: jest.fn() },
    adminUser: { findMany: jest.fn() },
    operationalSlaConfig: { findUnique: jest.fn(), create: jest.fn() },
  };
  return { mockPrisma };
}

describe('AdminKycService.getKycQueue — filter slaStatus eksak (ADM-006)', () => {
  let service: AdminKycService;
  let mockPrisma: ReturnType<typeof buildMocks>['mockPrisma'];

  // A: segar → OK; B: sisa < 20% budget → MENDEKATI;
  // C: lewat budget tapi kolom slaBreachedAt belum diset job → BREACHED;
  // D: dijeda & lewat budget → PAUSED (disjoint: tidak boleh ikut BREACHED).
  const candidates = () => [
    row('a', 'KYC-A', { slaStartedAt: new Date(now() - HOUR) }),
    row('b', 'KYC-B', { slaStartedAt: new Date(now() - 47.5 * HOUR) }),
    row('c', 'KYC-C', { slaStartedAt: new Date(now() - 50 * HOUR), slaBreachedAt: null }),
    row('d', 'KYC-D', {
      slaStartedAt: new Date(now() - 50 * HOUR),
      slaPausedAt: new Date(now() - 2 * HOUR),
      slaBreachedAt: new Date(now() - 2 * HOUR),
    }),
  ];

  beforeEach(async () => {
    const mocks = buildMocks();
    mockPrisma = mocks.mockPrisma;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminKycService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: { del: jest.fn() } },
        { provide: AuditLogService, useValue: { logAdminAction: jest.fn(), logUserAction: jest.fn() } },
        { provide: UploadService, useValue: {} },
        { provide: VerificationBadgeService, useValue: { invalidate: jest.fn() } },
        { provide: DashboardService, useValue: { invalidateSummaryCache: jest.fn() } },
        { provide: getQueueToken(EMAIL_QUEUE), useValue: { add: jest.fn() } },
      ],
    }).compile();
    service = module.get<AdminKycService>(AdminKycService);
    jest.clearAllMocks();
    mockPrisma.operationalSlaConfig.findUnique.mockResolvedValue({ slaHours: 48, useBusinessHours: false });
    mockPrisma.kycRequest.findMany.mockResolvedValue(candidates());
  });

  it("OK hanya mengembalikan baris berlabel OK (total dari hasil filter)", async () => {
    const res = await service.getKycQueue({ slaStatus: 'OK', page: 1, limit: 20 } as never);
    expect(res.total).toBe(1);
    expect(res.data.map((r: Record<string, unknown>) => r.kycId)).toEqual(['KYC-A']);
    expect((res.data[0] as Record<string, { status: string }>).sla.status).toBe('OK');
  });

  it('MENDEKATI hanya mengembalikan baris sisa < 20% budget', async () => {
    const res = await service.getKycQueue({ slaStatus: 'MENDEKATI', page: 1, limit: 20 } as never);
    expect(res.total).toBe(1);
    expect(res.data.map((r: Record<string, unknown>) => r.kycId)).toEqual(['KYC-B']);
  });

  it('BREACHED mencakup baris lewat-budget meski kolom slaBreachedAt belum diset', async () => {
    const res = await service.getKycQueue({ slaStatus: 'BREACHED', page: 1, limit: 20 } as never);
    expect(res.total).toBe(1);
    expect(res.data.map((r: Record<string, unknown>) => r.kycId)).toEqual(['KYC-C']);
  });

  it('PAUSED mencakup baris dijeda; baris dijeda tidak bocor ke BREACHED', async () => {
    const paused = await service.getKycQueue({ slaStatus: 'PAUSED', page: 1, limit: 20 } as never);
    expect(paused.total).toBe(1);
    expect(paused.data.map((r: Record<string, unknown>) => r.kycId)).toEqual(['KYC-D']);

    const breached = await service.getKycQueue({ slaStatus: 'BREACHED', page: 1, limit: 20 } as never);
    expect(breached.data.map((r: Record<string, unknown>) => r.kycId)).not.toContain('KYC-D');
  });

  it('paginasi memakai total hasil filter (limit 1 → totalPages sesuai)', async () => {
    const res = await service.getKycQueue({ slaStatus: 'OK', page: 1, limit: 1 } as never);
    expect(res.total).toBe(1);
    expect(res.totalPages).toBe(1);
    expect(res.data).toHaveLength(1);
  });
});
