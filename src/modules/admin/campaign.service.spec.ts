import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { CampaignStatus, CampaignType, MembershipRank } from '@prisma/client';
import { CampaignService } from './campaign.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { NotificationQueueService } from '../queue/notification-queue.service';

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
  voucher: { count: jest.fn(), create: jest.fn() },
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
    await expect(service.updateCampaign(baseCampaign.campaignId, 'admin', {})).rejects.toThrow('At least one campaign field');
  });
});
