import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { ReferralService } from '../referral.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';

type MockTransactionClient = {
  [K in keyof Prisma.TransactionClient as K extends `$${string}` ? never : K]?: Record<string, jest.Mock>;
} & {
  $queryRaw?: jest.Mock;
  $executeRaw?: jest.Mock;
};

const mockReferralCode = {
  id: 'rcode-1',
  code: 'REFABC123',
  userId: 'user-2',
  isActive: true,
  totalUses: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  user: { id: 'user-2', userId: 'usr_referrer' },
};

const mockReferralRelation = {
  id: 'rel-1',
  referralCodeId: 'rcode-1',
  referrerId: 'user-2',
  refereeId: 'user-1',
  createdAt: new Date(),
};

const mockPrisma = {
  referralCode: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
  },
  referralRelation: {
    findUnique: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  },
  referralReward: {
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findFirst: jest.fn(),
  },
  wallet: {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
  },
  walletTransaction: {
    create: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  hset: jest.fn(),
};

const mockWalletTxSerialService = {
  getNext: jest.fn().mockResolvedValue(2001),
};

const mockConfigService = {
  get: jest.fn().mockReturnValue(1000),
};

describe('ReferralService', () => {
  let service: ReferralService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: WalletTxSerialService, useValue: mockWalletTxSerialService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<ReferralService>(ReferralService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('applyCode — idempotency guard', () => {
    function setupTransactionMock(txOverrides: Record<string, Record<string, jest.Mock>>) {
      mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const txClient = {
          referralCode: { findUnique: jest.fn(), updateMany: jest.fn() },
          referralRelation: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
          ...txOverrides,
        };
        return cb(txClient);
      });
    }

    it('should throw NotFoundException when referral code does not exist', async () => {
      setupTransactionMock({
        referralCode: { findUnique: jest.fn().mockResolvedValue(null), updateMany: jest.fn() },
      });

      await expect(service.applyCode('user-1', 'BADCODE')).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when user tries to use their own referral code (self-referral)', async () => {
      setupTransactionMock({
        referralCode: {
          findUnique: jest.fn().mockResolvedValue({
            ...mockReferralCode,
            userId: 'user-1',
            user: { id: 'user-1', userId: 'usr_self' },
          }),
          updateMany: jest.fn(),
        },
      });

      await expect(service.applyCode('user-1', 'REFABC123')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when user has already applied a referral code (idempotency)', async () => {
      setupTransactionMock({
        referralCode: { findUnique: jest.fn().mockResolvedValue(mockReferralCode), updateMany: jest.fn() },
        referralRelation: { findUnique: jest.fn().mockResolvedValue(mockReferralRelation), findFirst: jest.fn(), create: jest.fn() },
      });

      await expect(service.applyCode('user-1', 'REFABC123')).rejects.toThrow(BadRequestException);
    });

    it('should not create a duplicate relation when called twice for the same user', async () => {
      const txCreate = jest.fn();
      setupTransactionMock({
        referralCode: { findUnique: jest.fn().mockResolvedValue(mockReferralCode), updateMany: jest.fn() },
        referralRelation: { findUnique: jest.fn().mockResolvedValue(mockReferralRelation), findFirst: jest.fn(), create: txCreate },
      });

      await expect(service.applyCode('user-1', 'REFABC123')).rejects.toThrow(BadRequestException);
      await expect(service.applyCode('user-1', 'REFABC123')).rejects.toThrow(BadRequestException);

      expect(txCreate).not.toHaveBeenCalled();
    });
  });

  describe('getOrCreateCode — collision retry', () => {
    it('should return existing code without generating a new one', async () => {
      const existingCode = { id: 'rcode-1', code: 'KHABCDEFGH', userId: 'user-1' };
      mockPrisma.referralCode.findUnique.mockResolvedValueOnce(existingCode);

      const result = await service.getOrCreateCode('user-1');

      expect(result).toBe(existingCode);
      expect(mockPrisma.referralCode.upsert).not.toHaveBeenCalled();
    });

    it('should retry on P2002 and succeed on second attempt', async () => {
      mockPrisma.referralCode.findUnique.mockResolvedValueOnce(null);
      const p2002Error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.0.0' });
      const createdCode = { id: 'rcode-2', code: 'KHRETRY001', userId: 'user-1' };
      mockPrisma.referralCode.upsert
        .mockRejectedValueOnce(p2002Error)
        .mockResolvedValueOnce(createdCode);

      const result = await service.getOrCreateCode('user-1');

      expect(result).toBe(createdCode);
      expect(mockPrisma.referralCode.upsert).toHaveBeenCalledTimes(2);
    });

    it('should throw BadRequestException with REFERRAL_CODE_GEN_FAILED after exhausting all retries', async () => {
      mockPrisma.referralCode.findUnique.mockResolvedValueOnce(null);
      const p2002Error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.0.0' });
      mockPrisma.referralCode.upsert
        .mockRejectedValueOnce(p2002Error)
        .mockRejectedValueOnce(p2002Error)
        .mockRejectedValueOnce(p2002Error);

      await expect(service.getOrCreateCode('user-1')).rejects.toThrow(BadRequestException);
      expect(mockPrisma.referralCode.upsert).toHaveBeenCalledTimes(3);

      mockPrisma.referralCode.findUnique.mockResolvedValueOnce(null);
      mockPrisma.referralCode.upsert
        .mockRejectedValueOnce(p2002Error)
        .mockRejectedValueOnce(p2002Error)
        .mockRejectedValueOnce(p2002Error);

      try {
        await service.getOrCreateCode('user-1');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toMatchObject({
          code: 'REFERRAL_CODE_GEN_FAILED',
        });
      }
    });
  });

  describe('regenerateCode — collision retry', () => {
    it('should retry on P2002 and succeed on second attempt', async () => {
      mockPrisma.referralCode.findUnique.mockResolvedValueOnce({ id: 'rcode-1', code: 'KHOLD12345', userId: 'user-1' });
      const p2002Error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.0.0' });
      const regeneratedCode = { id: 'rcode-1', code: 'KHNEW12345', userId: 'user-1' };
      mockPrisma.referralCode.upsert
        .mockRejectedValueOnce(p2002Error)
        .mockResolvedValueOnce(regeneratedCode);

      const result = await service.regenerateCode('user-1');

      expect(result).toBe(regeneratedCode);
      expect(mockPrisma.referralCode.upsert).toHaveBeenCalledTimes(2);
    });

    it('should throw BadRequestException with REFERRAL_CODE_GEN_FAILED after exhausting all retries', async () => {
      mockPrisma.referralCode.findUnique.mockResolvedValueOnce({ id: 'rcode-1', code: 'KHOLD12345', userId: 'user-1' });
      const p2002Error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.0.0' });
      mockPrisma.referralCode.upsert
        .mockRejectedValueOnce(p2002Error)
        .mockRejectedValueOnce(p2002Error)
        .mockRejectedValueOnce(p2002Error);

      try {
        await service.regenerateCode('user-1');
        fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toMatchObject({
          code: 'REFERRAL_CODE_GEN_FAILED',
        });
      }
      expect(mockPrisma.referralCode.upsert).toHaveBeenCalledTimes(3);
    });

    // C-13: `totalReferrals` is the only thing enforcing MAX_REFERRALS_PER_CODE (applyCode
    // guards on `totalReferrals: { lt: MAX }`). Regeneration is self-service (3/hour), so if it
    // reset the counter a capped user could keep referring without bound — each qualifying
    // referral pays out 2 x Rp 5.000 of platform funds.
    it('should NOT reset totalReferrals when regenerating (referral cap must survive)', async () => {
      mockPrisma.referralCode.findUnique.mockResolvedValueOnce({ id: 'rcode-1', code: 'KHOLD12345', userId: 'user-1', totalReferrals: 100 });
      mockPrisma.referralCode.upsert.mockResolvedValueOnce({ id: 'rcode-1', code: 'KHNEW12345', userId: 'user-1', totalReferrals: 100 });

      await service.regenerateCode('user-1');

      const upsertArg = mockPrisma.referralCode.upsert.mock.calls[0][0] as {
        update: Record<string, unknown>;
      };
      expect(upsertArg.update).not.toHaveProperty('totalReferrals');
      expect(upsertArg.update).toMatchObject({ isActive: true });
    });
  });

  describe('applyCode — referral cap enforcement', () => {
    it('should reject with REFERRAL_LIMIT_REACHED when the guarded update matches no row', async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const create = jest.fn();
      mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          referralCode: { findUnique: jest.fn().mockResolvedValue(mockReferralCode), updateMany },
          referralRelation: {
            findUnique: jest.fn().mockResolvedValue(null),
            findFirst: jest.fn().mockResolvedValue(null),
            create,
          },
        }),
      );

      try {
        await service.applyCode('user-1', 'REFABC123');
        fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toMatchObject({
          code: 'REFERRAL_LIMIT_REACHED',
        });
      }

      // The cap is enforced by the WHERE clause, not by a read-then-write check.
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ totalReferrals: { lt: 1000 } }),
        }),
      );
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('applyCode — P2002 to friendly error mapping', () => {
    it('should convert P2002 unique constraint error to REFERRAL_ALREADY_APPLIED', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.0.0' });
      mockPrisma.$transaction.mockRejectedValueOnce(p2002Error);

      await expect(service.applyCode('user-1', 'KHTEST1234')).rejects.toThrow(BadRequestException);

      try {
        mockPrisma.$transaction.mockRejectedValueOnce(p2002Error);
        await service.applyCode('user-1', 'KHTEST1234');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toMatchObject({
          code: 'REFERRAL_ALREADY_APPLIED',
        });
      }
    });
  });

  describe('createReferralRewardIfEligible — double reward prevention', () => {
    it('should not credit reward when referral relation does not exist for buyer', async () => {
      const mockTx: MockTransactionClient = {
        referralRelation: { findUnique: jest.fn().mockResolvedValue(null) },
        referralReward: { create: jest.fn(), count: jest.fn() },
        order: { findUnique: jest.fn() },
        wallet: { findUnique: jest.fn() },
        walletTransaction: { create: jest.fn() },
        referralCode: { update: jest.fn() },
      };

      await service.createReferralRewardIfEligible('user-no-referral', BigInt(50000), 'order-1', mockTx as unknown as Prisma.TransactionClient);

      expect(mockTx.referralReward!.create).not.toHaveBeenCalled();
    });

    it('should skip reward creation when reward already exists for the same order and user (per-recipient idempotency)', async () => {
      const mockTx: MockTransactionClient = {
        referralRelation: {
          findUnique: jest.fn().mockResolvedValue({ id: 'rel-1', referrerId: 'user-2', refereeId: 'user-1', isRewardActive: false }),
          update: jest.fn(),
        },
        order: {
          findUnique: jest.fn().mockResolvedValue({ status: 'COMPLETED' }),
          count: jest.fn().mockResolvedValue(1),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ kycStatus: 'APPROVED' }),
        },
        referralReward: {
          findFirst: jest.fn().mockResolvedValue({ id: 'reward-1', isCredited: true }),
          create: jest.fn(),
          update: jest.fn(),
        },
        wallet: {
          findUnique: jest.fn(),
          count: jest.fn().mockResolvedValue(2),
          updateMany: jest.fn(),
        },
        walletTransaction: { create: jest.fn() },
        referralCode: { update: jest.fn(), updateMany: jest.fn() },
      };

      await service.createReferralRewardIfEligible('user-1', BigInt(50000), 'order-1', mockTx as unknown as Prisma.TransactionClient);

      expect(mockTx.referralReward!.create).not.toHaveBeenCalled();
      expect(mockTx.walletTransaction!.create).not.toHaveBeenCalled();
    });

    it('should skip reward when order is not COMPLETED', async () => {
      const mockTx: MockTransactionClient = {
        referralRelation: { findUnique: jest.fn().mockResolvedValue({ id: 'rel-1', referrerId: 'user-2', refereeId: 'user-1', isRewardActive: false }) },
        order: { findUnique: jest.fn().mockResolvedValue({ status: 'CANCELLED' }) },
        referralReward: { count: jest.fn(), create: jest.fn() },
        wallet: { findUnique: jest.fn() },
        walletTransaction: { create: jest.fn() },
        referralCode: { update: jest.fn(), updateMany: jest.fn() },
      };

      await service.createReferralRewardIfEligible('user-1', BigInt(50000), 'order-1', mockTx as unknown as Prisma.TransactionClient);

      expect(mockTx.referralReward!.create).not.toHaveBeenCalled();
    });

    it('should skip reward when referee has more than 1 completed transaction (not first order)', async () => {
      let orderCountCall = 0;
      const mockTx: MockTransactionClient = {
        referralRelation: { findUnique: jest.fn().mockResolvedValue({ id: 'rel-1', referrerId: 'user-2', refereeId: 'user-1', isRewardActive: false }) },
        order: {
          findUnique: jest.fn().mockResolvedValue({ status: 'COMPLETED' }),
          count: jest.fn().mockImplementation(() => {
            orderCountCall++;
            if (orderCountCall === 1) return Promise.resolve(3);
            return Promise.resolve(5);
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ kycStatus: 'APPROVED' }),
        },
        referralReward: { findFirst: jest.fn(), create: jest.fn() },
        wallet: { findUnique: jest.fn() },
        walletTransaction: { create: jest.fn() },
        referralCode: { update: jest.fn(), updateMany: jest.fn() },
      };

      await service.createReferralRewardIfEligible('user-1', BigInt(50000), 'order-1', mockTx as unknown as Prisma.TransactionClient);

      expect(mockTx.referralReward!.create).not.toHaveBeenCalled();
    });

    it('should skip reward atomically when one referral wallet is missing', async () => {
      const mockTx: MockTransactionClient = {
        referralRelation: { findUnique: jest.fn().mockResolvedValue({ id: 'rel-1', referrerId: 'user-2', refereeId: 'user-1', isRewardActive: false }) },
        order: { findUnique: jest.fn().mockResolvedValue({ status: 'COMPLETED' }), count: jest.fn().mockResolvedValue(1) },
        user: { findUnique: jest.fn().mockResolvedValue({ kycStatus: 'APPROVED' }) },
        wallet: { count: jest.fn().mockResolvedValue(1) },
        referralReward: { findFirst: jest.fn(), create: jest.fn() },
      };
      await service.createReferralRewardIfEligible('user-1', BigInt(50000), 'order-1', mockTx as unknown as Prisma.TransactionClient);
      expect(mockTx.referralReward!.create).not.toHaveBeenCalled();
    });

    it('should create reward on first call and skip on second call for the same order', async () => {
      const mockTx: MockTransactionClient = {
        referralRelation: {
          findUnique: jest.fn().mockResolvedValue({ id: 'rel-1', referrerId: 'user-2', refereeId: 'user-1', isRewardActive: false }),
          update: jest.fn(),
        },
        order: {
          findUnique: jest.fn().mockResolvedValue({ status: 'COMPLETED' }),
          count: jest.fn().mockResolvedValue(1),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ kycStatus: 'APPROVED' }),
        },
        referralReward: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'reward-1', triggeredByOrderId: 'order-1', isCredited: false }),
          update: jest.fn(),
        },
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'wallet-2', totalBalance: BigInt(100000) }]),
        wallet: {
          count: jest.fn().mockResolvedValue(2),
          update: jest.fn(),
        },
        walletTransaction: { create: jest.fn().mockResolvedValue({ id: 'tx-1' }) },
        referralCode: { update: jest.fn(), updateMany: jest.fn() },
      };

      (mockWalletTxSerialService.getNext as jest.Mock).mockResolvedValue(3001);

      await service.createReferralRewardIfEligible('user-1', BigInt(50000), 'order-1', mockTx as unknown as Prisma.TransactionClient);
      expect(mockTx.referralReward!.create).toHaveBeenCalled();

      jest.clearAllMocks();
      (mockTx.referralRelation!.findUnique as jest.Mock).mockResolvedValue({ id: 'rel-1', referrerId: 'user-2', refereeId: 'user-1', isRewardActive: false });
      (mockTx.order!.findUnique as jest.Mock).mockResolvedValue({ status: 'COMPLETED' });
      (mockTx.order!.count as jest.Mock).mockResolvedValue(1);
      (mockTx.user!.findUnique as jest.Mock).mockResolvedValue({ kycStatus: 'APPROVED' });
      (mockTx.referralReward!.findFirst as jest.Mock).mockResolvedValue({ id: 'reward-1', isCredited: true });

      await service.createReferralRewardIfEligible('user-1', BigInt(50000), 'order-1', mockTx as unknown as Prisma.TransactionClient);
      expect(mockTx.referralReward!.create).not.toHaveBeenCalled();
    });
  });
});
