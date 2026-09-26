import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ShowcaseVisibility } from '@prisma/client';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ShowcaseService } from '../showcase.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { UploadService } from '../../upload/upload.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { ReportShowcaseDto } from '../dto/report-showcase.dto';
import * as ErrorCodes from '../../../common/constants/error-codes';

const OWNER_ID = 'owner-1';
const REPORTER_ID = 'reporter-1';
const SHOWCASE_ID = 'cshowcase000000000000001';

function showcaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SHOWCASE_ID,
    userId: OWNER_ID,
    title: 'Ilustrasi karakter',
    description: 'Deskripsi item.',
    category: 'ilustrasi',
    visibility: ShowcaseVisibility.PUBLIC,
    priceMin: 150000n,
    priceMax: null,
    isActive: true,
    sortOrder: 0,
    likeCount: 4,
    commentCount: 2,
    viewCount: 10,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    images: [],
    user: {
      id: OWNER_ID,
      userId: 'USR-OWNER01',
      username: 'seller',
      fullName: 'Toko Seller',
      avatarUrl: null,
      kycStatus: 'PENDING',
      isVip: false,
      membershipRank: 'BRONZE',
      isActive: true,
      isBanned: false,
      deletedAt: null,
      profileVisible: true,
    },
    ...overrides,
  };
}

function ownerHealthy(row: any): boolean {
  const u = row.user;
  return u.isActive !== false && u.isBanned !== true && u.deletedAt == null && u.profileVisible !== false;
}

/** Meniru logika OR di findVisibleShowcase untuk mock. */
function matchesShowcaseWhere(row: any, where: any): boolean {
  if (!row) return false;
  if (where?.id && row.id !== where.id) return false;
  if (where?.isActive !== undefined && row.isActive !== where.isActive) return false;
  if (!where?.OR) return true;
  return where.OR.some((branch: any) => {
    if (branch.userId !== undefined && row.userId !== branch.userId) return false;
    if (branch.visibility !== undefined && row.visibility !== branch.visibility) return false;
    if (branch.user && !ownerHealthy(row)) return false;
    return true;
  });
}

const mockPrisma: any = {
  blockList: { findFirst: jest.fn(), findMany: jest.fn() },
  userShowcase: { findFirst: jest.fn() },
  showcaseReport: { findUnique: jest.fn(), create: jest.fn() },
};

const mockRedis = { setNx: jest.fn() };
const mockUpload = {};
const mockConfig = { get: jest.fn() };
const mockAuditLog = { logUserAction: jest.fn(), logAdminAction: jest.fn() };

describe('ShowcaseService — reportShowcase (K-1)', () => {
  let service: ShowcaseService;
  let dbShowcase: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    dbShowcase = showcaseRow();
    mockPrisma.userShowcase.findFirst.mockImplementation(async (args: any) =>
      matchesShowcaseWhere(dbShowcase, args?.where) ? dbShowcase : null,
    );
    mockPrisma.blockList.findFirst.mockResolvedValue(null);
    mockPrisma.blockList.findMany.mockResolvedValue([]);
    // Default: belum pernah dilaporkan.
    mockPrisma.showcaseReport.findUnique.mockResolvedValue(null);
    mockPrisma.showcaseReport.create.mockImplementation(async (args: any) => ({
      id: 'creport000000000000001',
      ...args.data,
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShowcaseService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: UploadService, useValue: mockUpload },
        { provide: ConfigService, useValue: mockConfig },
        { provide: AuditLogService, useValue: mockAuditLog },
      ],
    }).compile();
    service = module.get<ShowcaseService>(ShowcaseService);
  });

  function validDto(overrides: Record<string, unknown> = {}): ReportShowcaseDto {
    const dto = new ReportShowcaseDto();
    dto.reason = 'Konten tidak pantas';
    Object.assign(dto, overrides);
    return dto;
  }

  it('berhasil melaporkan item PUBLIC yang terlihat → return { reported: true, reportId }', async () => {
    const result = await service.reportShowcase(REPORTER_ID, SHOWCASE_ID, validDto(), { ipAddress: '1.2.3.4' });

    expect(result).toEqual({ reported: true, reportId: 'creport000000000000001' });
    expect(mockPrisma.showcaseReport.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          showcaseId: SHOWCASE_ID,
          reporterId: REPORTER_ID,
          reason: 'Konten tidak pantas',
        }),
      }),
    );
    // Audit trail sisi user dengan action yang benar + IP dari request.
    expect(mockAuditLog.logUserAction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: REPORTER_ID,
        action: 'SHOWCASE_REPORTED',
        entityType: 'ShowcaseItem',
        entityId: SHOWCASE_ID,
        ipAddress: '1.2.3.4',
      }),
    );
  });

  it('item PRIVATE → 404 (tidak bisa dilaporkan)', async () => {
    dbShowcase = showcaseRow({ visibility: ShowcaseVisibility.PRIVATE });

    await expect(service.reportShowcase(REPORTER_ID, SHOWCASE_ID, validDto())).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCodes.SHOWCASE_NOT_FOUND }),
    });
    expect(mockPrisma.showcaseReport.create).not.toHaveBeenCalled();
  });

  it('item tidak ada → 404', async () => {
    dbShowcase = null;

    await expect(service.reportShowcase(REPORTER_ID, 'ctidakada00000000000001', validDto())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockPrisma.showcaseReport.create).not.toHaveBeenCalled();
  });

  it('melaporkan item sendiri → 400', async () => {
    await expect(service.reportShowcase(OWNER_ID, SHOWCASE_ID, validDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockPrisma.showcaseReport.create).not.toHaveBeenCalled();
  });

  it('lapor 2x → 409 SHOWCASE_ALREADY_REPORTED', async () => {
    mockPrisma.showcaseReport.findUnique.mockResolvedValue({ id: 'creport000000000000001' });

    await expect(service.reportShowcase(REPORTER_ID, SHOWCASE_ID, validDto())).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCodes.SHOWCASE_ALREADY_REPORTED }),
    });
    expect(mockPrisma.showcaseReport.create).not.toHaveBeenCalled();
  });

  it('race condition (P2002) → 409 SHOWCASE_ALREADY_REPORTED', async () => {
    mockPrisma.showcaseReport.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );

    await expect(service.reportShowcase(REPORTER_ID, SHOWCASE_ID, validDto())).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCodes.SHOWCASE_ALREADY_REPORTED }),
    });
  });

  it('kegagalan audit log tidak menggagalkan laporan', async () => {
    mockAuditLog.logUserAction.mockImplementationOnce(() => {
      throw new Error('queue down');
    });

    const result = await service.reportShowcase(REPORTER_ID, SHOWCASE_ID, validDto());
    expect(result.reported).toBe(true);
  });
});

describe('ReportShowcaseDto — validasi', () => {
  async function violations(body: Record<string, unknown>) {
    const dto = plainToInstance(ReportShowcaseDto, body);
    return validate(dto);
  }

  it('reason kosong → error validasi (400 oleh ValidationPipe)', async () => {
    expect(await violations({ reason: '' })).not.toHaveLength(0);
    expect(await violations({})).not.toHaveLength(0);
  });

  it('reason < 3 karakter → error validasi', async () => {
    expect(await violations({ reason: 'ab' })).not.toHaveLength(0);
  });

  it('reason > 100 karakter → error validasi', async () => {
    expect(await violations({ reason: 'x'.repeat(101) })).not.toHaveLength(0);
  });

  it('description > 1000 karakter → error validasi', async () => {
    expect(await violations({ reason: 'Spam', description: 'x'.repeat(1001) })).not.toHaveLength(0);
  });

  it('reason valid + description opsional → lolos validasi', async () => {
    expect(await violations({ reason: 'Konten menipu' })).toHaveLength(0);
    expect(await violations({ reason: 'Konten menipu', description: 'Detail tambahan.' })).toHaveLength(0);
  });

  it('reason di-trim otomatis', async () => {
    const dto = plainToInstance(ReportShowcaseDto, { reason: '  Spam  ' });
    await validate(dto);
    expect(dto.reason).toBe('Spam');
  });

  // Guard terhadap issue K-1 #1: reason undefined/tidak terkirim harus ditolak.
  it('reason undefined → error validasi', async () => {
    const dto = plainToInstance(ReportShowcaseDto, { reason: undefined });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
