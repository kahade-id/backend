import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { CampaignService } from './campaign.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../common/services/audit-log.service';

const mockPrisma = { campaign: { count: jest.fn(), create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), delete: jest.fn() } };
const mockAuditLog = { logAdminAction: jest.fn() };
const baseCampaign = {
  id: 'cuid', campaignId: 'CMP-20260822-000001-abc', name: 'Campaign', description: null, type: 'FEE_PROMO', status: 'DRAFT',
  startsAt: new Date('2026-01-01'), endsAt: new Date('2026-02-01'), discountValue: null, discountPercent: null, maxDiscount: null,
  freeTransactions: null, targetAudience: null, maxRedemptions: 100, currentRedemptions: 10, rolloutPercent: null, createdBy: 'admin',
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
};

describe('CampaignService', () => {
  let service: CampaignService;
  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({ providers: [CampaignService, { provide: PrismaService, useValue: mockPrisma }, { provide: AuditLogService, useValue: mockAuditLog }] }).compile();
    service = module.get(CampaignService);
  });

  it('rejects invalid create dates before generating an ID', async () => {
    await expect(service.createCampaign('admin', { name: 'x', type: 'FEE_PROMO' as any, startsAt: new Date('invalid'), endsAt: new Date('2026-01-01') })).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.campaign.count).not.toHaveBeenCalled();
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

  it('rejects an update with no actual fields', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue(baseCampaign);
    await expect(service.updateCampaign(baseCampaign.campaignId, 'admin', {})).rejects.toThrow('At least one campaign field');
  });
});
