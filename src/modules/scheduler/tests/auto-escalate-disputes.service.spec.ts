import { Test } from '@nestjs/testing';
import { DisputeStatus, MembershipRank } from '@prisma/client';
import { AutoEscalateDisputesService } from '../services/auto-escalate-disputes.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';

describe('AutoEscalateDisputesService', () => {
  it('prioritizes breached disputes involving GOLD+ ranks before lower ranks', async () => {
    const prisma = {
      dispute: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'disp-silver',
            disputeId: 'DSP-SILVER',
            status: DisputeStatus.UNDER_REVIEW,
            order: {
              buyer: { membershipRank: MembershipRank.SILVER },
              seller: { membershipRank: MembershipRank.BRONZE },
            },
          },
          {
            id: 'disp-gold',
            disputeId: 'DSP-GOLD',
            status: DisputeStatus.UNDER_REVIEW,
            order: {
              buyer: { membershipRank: MembershipRank.GOLD },
              seller: { membershipRank: MembershipRank.BRONZE },
            },
          },
          {
            id: 'disp-diamond',
            disputeId: 'DSP-DIAMOND',
            status: DisputeStatus.UNDER_REVIEW,
            order: {
              buyer: { membershipRank: MembershipRank.BRONZE },
              seller: { membershipRank: MembershipRank.DIAMOND },
            },
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      adminUser: {
        findFirst: jest.fn().mockResolvedValue({ id: 'admin-1' }),
      },
      adminAuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    };
    const redis = {
      isHealthy: jest.fn().mockResolvedValue(true),
      setNx: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
    };
    const module = await Test.createTestingModule({
      providers: [
        AutoEscalateDisputesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    await module.get(AutoEscalateDisputesService).escalateBreachedDisputes();

    const processedIds = prisma.dispute.updateMany.mock.calls.map((call) => call[0].where.id);
    expect(processedIds).toEqual(['disp-diamond', 'disp-gold', 'disp-silver']);
    expect(prisma.dispute.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ slaDeadlineAt: 'asc' }, { id: 'asc' }],
    }));
  });
});
