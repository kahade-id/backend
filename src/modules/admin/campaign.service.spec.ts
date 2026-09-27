import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AuditAction, CampaignStatus, CampaignType, MembershipRank } from '@prisma/client';
import { CampaignService } from './campaign.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { NotificationQueueService } from '../queue/notification-queue.service';
import * as ErrorCodes from '../../common/constants/error-codes';

const mockPrisma = {
  campaign: {
    count: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
  },
  user: { findMany: jest.fn() },
  voucher: { count: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
  voucherUsage: { findMany: jest.fn(), aggregate: jest.fn() },
  campaignVersion: { aggregate: jest.fn(), create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  $transaction: jest.fn(),
};
const mockAuditLog = { logAdminAction: jest.fn() };
const mockNotificationQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
const baseCampaign = {
  id: 'cuid',
  campaignId: 'CMP-20260822-000001-abc',
  name: 'Campaign',
  description: null,
  type: CampaignType.FEE_PROMO,
  status: CampaignStatus.DRAFT,
  startsAt: new Date('2026-01-01'),
  endsAt: new Date('2026-02-01'),
  discountValue: null,
  discountPercent: null,
  maxDiscount: null,
  freeTransactions: null,
  targetAudience: null,
  targetMinRank: null,
  targetDormantDays: null,
  targetNewUserOnly: false,
  promoCode: null,
  maxRedemptions: 100,
  currentRedemptions: 10,
  rolloutPercent: null,
  createdBy: 'admin',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

describe('CampaignService', () => {
  let service: CampaignService;
  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditLogService, useValue: mockAuditLog },
        { provide: NotificationQueueService, useValue: mockNotificationQueue },
      ],
    }).compile();
    service = module.get(CampaignService);
  });

  it('rejects invalid create dates before generating an ID', async () => {
    await expect(service.createCampaign('admin', { name: 'x', type: CampaignType.FEE_PROMO, startsAt: new Date('invalid'), endsAt: new Date('2026-01-01') })).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.campaign.count).not.toHaveBeenCalled();
  });

  it('persists structured targeting and normalized promo code when creating a promo campaign', async () => {
    mockPrisma.campaign.count.mockResolvedValueOnce(0);
    mockPrisma.campaign.create.mockImplementationOnce(async ({ data }) => ({ ...baseCampaign, ...data }));

    const result = await service.createCampaign('admin', {
      name: 'Gold Cashback',
      type: CampaignType.CASHBACK,
      startsAt: new Date('2026-01-01'),
      endsAt: new Date('2026-02-01'),
      discountValue: 10_000,
      targetAudience: 'Legacy admin label',
      targetMinRank: MembershipRank.GOLD,
      targetDormantDays: 30,
      targetNewUserOnly: false,
      rolloutPercent: 50,
      promoCode: ' gold-50 ',
    });

    expect(mockPrisma.campaign.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: CampaignType.CASHBACK,
        discountValue: BigInt(1_000_000),
        targetAudience: 'Legacy admin label',
        targetMinRank: MembershipRank.GOLD,
        targetDormantDays: 30,
        targetNewUserOnly: false,
        rolloutPercent: 50,
        promoCode: 'GOLD-50',
      }),
    }));
    expect(result).toMatchObject({ promoCode: 'GOLD-50', targetMinRank: MembershipRank.GOLD, targetDormantDays: 30 });
  });

  it('normalizes negative page and over-large limit for campaign lists', async () => {
    mockPrisma.campaign.findMany.mockResolvedValue([]);
    mockPrisma.campaign.count.mockResolvedValue(0);
    await service.getCampaigns(-10, 999);
    expect(mockPrisma.campaign.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 50 }));
  });

  it('rejects update date inversion against the existing campaign date', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue(baseCampaign);
    await expect(service.updateCampaign(baseCampaign.campaignId, 'admin', { endsAt: new Date('2025-12-31') })).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.campaign.update).not.toHaveBeenCalled();
  });

  it('rejects lowering max redemptions below current usage', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue(baseCampaign);
    await expect(service.updateCampaign(baseCampaign.campaignId, 'admin', { maxRedemptions: 9 })).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.campaign.update).not.toHaveBeenCalled();
  });

  it('rejects decreasing staged rollout percentage after it has been set', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue({ ...baseCampaign, rolloutPercent: 70 });
    await expect(service.updateCampaign(baseCampaign.campaignId, 'admin', { rolloutPercent: 50 })).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.campaign.update).not.toHaveBeenCalled();
  });

  it('rejects an update with no actual fields', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue(baseCampaign);
    await expect(service.updateCampaign(baseCampaign.campaignId, 'admin', {
      changeReason: 'Tidak ada perubahan berarti',
    })).rejects.toThrow('At least one campaign field');
  });

  it('G351: rejects changing locked fields once the campaign is no longer DRAFT', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue({ ...baseCampaign, status: CampaignStatus.ACTIVE, promoCode: 'LAMA123' });
    await expect(
      service.updateCampaign(baseCampaign.campaignId, 'admin', {
        promoCode: 'BARU123',
        changeReason: 'Ubah kode promo aktif',
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: ErrorCodes.CAMPAIGN_FIELD_LOCKED }) });
    expect(mockPrisma.campaign.update).not.toHaveBeenCalled();
    expect(mockPrisma.campaignVersion.create).not.toHaveBeenCalled();
  });

  it('G351: still allows editing unlocked fields on an ACTIVE campaign', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue({ ...baseCampaign, status: CampaignStatus.ACTIVE, promoCode: 'LAMA123' });
    mockPrisma.campaignVersion.aggregate.mockResolvedValue({ _max: { version: 1 } });
    mockPrisma.campaignVersion.create.mockResolvedValue({});
    mockPrisma.campaign.update.mockResolvedValue({ ...baseCampaign, name: 'Nama baru' });
    const result = await service.updateCampaign(baseCampaign.campaignId, 'admin', {
      name: 'Nama baru',
      promoCode: 'LAMA123', // nilai sama → tidak dianggap perubahan field terkunci
      changeReason: 'Perbaiki nama campaign',
    });
    expect(result).toMatchObject({ name: 'Nama baru' });
  });

  it('G353: writes a CampaignVersion with incremented version BEFORE the update, plus CAMPAIGN_UPDATED audit', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue(baseCampaign);
    mockPrisma.campaignVersion.aggregate.mockResolvedValue({ _max: { version: 5 } });
    mockPrisma.campaignVersion.create.mockResolvedValue({});
    mockPrisma.campaign.update.mockResolvedValue({ ...baseCampaign, name: 'Nama baru' });

    await service.updateCampaign(baseCampaign.campaignId, 'admin', {
      name: 'Nama baru',
      changeReason: 'Perpanjang periode promo akhir tahun',
    });

    expect(mockPrisma.campaignVersion.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.campaignVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        version: 6,
        changedBy: 'admin',
        changeReason: 'Perpanjang periode promo akhir tahun',
      }),
    }));
    const createCalls = mockPrisma.campaignVersion.create.mock.invocationCallOrder[0];
    const updateCalls = mockPrisma.campaign.update.mock.invocationCallOrder[0];
    expect(createCalls).toBeLessThan(updateCalls);
    expect(mockAuditLog.logAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.CAMPAIGN_UPDATED,
      targetId: baseCampaign.campaignId,
    }));
  });

  it('G356: rejects deleting a DRAFT campaign that has issued vouchers without force', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue(baseCampaign);
    mockPrisma.voucher.count.mockResolvedValue(3);
    await expect(
      service.deleteCampaign(baseCampaign.campaignId, 'admin', {}),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: ErrorCodes.CAMPAIGN_HAS_VOUCHERS }) });
    expect(mockPrisma.campaign.delete).not.toHaveBeenCalled();
  });

  it('G356: rejects deleting an ACTIVE campaign even when no vouchers were issued', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue({ ...baseCampaign, status: CampaignStatus.ACTIVE });
    mockPrisma.voucher.count.mockResolvedValue(0);
    await expect(service.deleteCampaign(baseCampaign.campaignId, 'admin', {})).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.campaign.delete).not.toHaveBeenCalled();
  });

  it('G357: deletes a DRAFT campaign with issued vouchers only with force+reason, deactivating vouchers and auditing CAMPAIGN_DELETED', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue(baseCampaign);
    mockPrisma.voucher.count.mockResolvedValue(3);
    mockPrisma.$transaction.mockResolvedValue([{ count: 3 }, baseCampaign]);

    const result = await service.deleteCampaign(baseCampaign.campaignId, 'admin', {
      force: true,
      reason: 'Salah konfigurasi target audiens',
    });

    expect(result).toEqual({ message: 'Campaign deleted' });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1); // vouchers dinonaktifkan + campaign dihapus atomik
    expect(mockAuditLog.logAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.CAMPAIGN_DELETED,
      targetId: baseCampaign.campaignId,
    }));
  });

  it('G356: deletes a DRAFT campaign without issued vouchers without force', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue(baseCampaign);
    mockPrisma.voucher.count.mockResolvedValue(0);
    mockPrisma.$transaction.mockResolvedValue([{ count: 0 }, baseCampaign]);
    const result = await service.deleteCampaign(baseCampaign.campaignId, 'admin', {});
    expect(result).toEqual({ message: 'Campaign deleted' });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('G359-G361: activate is idempotent for an already-ACTIVE campaign (no duplicate version, no audit)', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue({ ...baseCampaign, status: CampaignStatus.ACTIVE });
    const result = await service.activateCampaign(baseCampaign.campaignId, 'admin', { reason: 'Mulai promo akhir tahun' });
    expect(result).toMatchObject({ alreadyActive: true });
    expect(mockPrisma.campaignVersion.create).not.toHaveBeenCalled();
    expect(mockPrisma.voucher.create).not.toHaveBeenCalled();
    expect(mockAuditLog.logAdminAction).not.toHaveBeenCalled();
  });

  it('G359: pause writes a CampaignVersion and PAUSE_REASON_RECORDED audit with the mandatory reason', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue({ ...baseCampaign, status: CampaignStatus.ACTIVE });
    mockPrisma.campaignVersion.aggregate.mockResolvedValue({ _max: { version: 2 } });
    mockPrisma.campaignVersion.create.mockResolvedValue({});
    mockPrisma.campaign.update.mockResolvedValue({ ...baseCampaign, status: CampaignStatus.PAUSED });

    await service.pauseCampaign(baseCampaign.campaignId, 'admin', 'Anggaran promo bulan ini habis');

    expect(mockPrisma.campaignVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        version: 3,
        changedBy: 'admin',
        changeReason: 'Jeda: Anggaran promo bulan ini habis',
      }),
    }));
    expect(mockAuditLog.logAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.PAUSE_REASON_RECORDED,
      targetId: baseCampaign.campaignId,
    }));
  });

  it('G359: rejects pause without a reason', async () => {
    await expect(service.pauseCampaign(baseCampaign.campaignId, 'admin', '')).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.campaign.update).not.toHaveBeenCalled();
  });
});
