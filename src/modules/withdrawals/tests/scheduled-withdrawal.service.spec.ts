import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ScheduledWithdrawalService } from '../scheduled-withdrawal.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';

jest.mock('../../../common/utils/crypto.util', () => ({ decryptAES: jest.fn(async (s: string) => s) }));

const mockConfig = {
  get: jest.fn((key: string) => {
    if (key === 'app.walletMinWithdraw') return 50000;
    if (key === 'app.walletMaxWithdrawPerTx') return 25_000_000;
    if (key === 'app.walletDailyWithdrawLimit') return 50_000_000;
    return undefined;
  }),
};

const mockPrisma = {
  scheduledWithdrawal: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  bankAccount: { findFirst: jest.fn() },
  wallet: { findUnique: jest.fn(), updateMany: jest.fn() },
  walletTransaction: { create: jest.fn() },
  $transaction: jest.fn(),
  $executeRaw: jest.fn(),
  $queryRaw: jest.fn(),
};
const mockSerial = { getNext: jest.fn().mockResolvedValue(123) };

describe('ScheduledWithdrawalService', () => {
  let service: ScheduledWithdrawalService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockSerial.getNext.mockResolvedValue(123);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledWithdrawalService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletTxSerialService, useValue: mockSerial },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get<ScheduledWithdrawalService>(ScheduledWithdrawalService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('createSchedule', () => {
    it('throws BadRequestException for invalid dayOfWeek', async () => {
      await expect(service.createSchedule('u1', { bankAccountId: 'b1', dayOfWeek: 7 })).rejects.toThrow(BadRequestException);
      await expect(service.createSchedule('u1', { bankAccountId: 'b1', dayOfWeek: -1 })).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for missing bank account', async () => {
      mockPrisma.bankAccount.findFirst.mockResolvedValue(null);
      await expect(service.createSchedule('u1', { bankAccountId: 'b1', dayOfWeek: 1 })).rejects.toThrow(NotFoundException);
    });

    it('rejects scheduling an unverified bank account', async () => {
      mockPrisma.bankAccount.findFirst.mockResolvedValue({ id: 'b1', isVerified: false });
      await expect(service.createSchedule('u1', { bankAccountId: 'b1', dayOfWeek: 1 })).rejects.toMatchObject({ response: { code: 'BANK_ACCOUNT_NOT_VERIFIED' } });
    });

    it('throws BadRequestException when schedule already exists', async () => {
      mockPrisma.bankAccount.findFirst.mockResolvedValue({ id: 'b1', isVerified: true });
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue({ id: 'old' });
      await expect(service.createSchedule('u1', { bankAccountId: 'b1', dayOfWeek: 1 })).rejects.toThrow(BadRequestException);
    });

    it('creates schedule with minAmount converted to sen', async () => {
      mockPrisma.bankAccount.findFirst.mockResolvedValue({ id: 'b1', isVerified: true });
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue(null);
      mockPrisma.scheduledWithdrawal.create.mockResolvedValue({
        id: 's1', dayOfWeek: 1, minAmount: BigInt(5000000), isActive: true,
        bankAccountId: 'b1', lastExecutedAt: null, createdAt: new Date(),
      });
      const res = await service.createSchedule('u1', { bankAccountId: 'b1', dayOfWeek: 1, minAmount: 50000 });
      expect((res as any).dayName).toBe('Monday');
      expect(mockPrisma.scheduledWithdrawal.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ minAmount: BigInt(5000000) }),
      }));
    });

    it('rejects a zero or excessive user-defined schedule minimum before any account lookup', async () => {
      await expect(service.createSchedule('u1', { bankAccountId: 'b1', dayOfWeek: 1, minAmount: 0 })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'INVALID_SCHEDULE' }),
      });
      await expect(service.createSchedule('u1', { bankAccountId: 'b1', dayOfWeek: 1, minAmount: 100_000_001 })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'INVALID_SCHEDULE' }),
      });
      expect(mockPrisma.bankAccount.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('getSchedules', () => {
    it('returns active schedules', async () => {
      mockPrisma.scheduledWithdrawal.findMany.mockResolvedValue([{
        id: 's1', dayOfWeek: 0, minAmount: BigInt(0), isActive: true,
        bankAccountId: 'b1', lastExecutedAt: null, createdAt: new Date(),
      }]);
      const res = await service.getSchedules('u1');
      expect(res).toHaveLength(1);
      expect((res[0] as any).dayName).toBe('Sunday');
    });
  });

  describe('updateSchedule', () => {
    it('throws NotFoundException when missing', async () => {
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue(null);
      await expect(service.updateSchedule('u1', 's1', {})).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException for not owner', async () => {
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue({ userId: 'other' });
      await expect(service.updateSchedule('u1', 's1', {})).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException for invalid dayOfWeek', async () => {
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue({ userId: 'u1' });
      await expect(service.updateSchedule('u1', 's1', { dayOfWeek: 9 })).rejects.toThrow(BadRequestException);
    });

    it('updates fields and converts minAmount', async () => {
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue({ userId: 'u1' });
      mockPrisma.scheduledWithdrawal.update.mockResolvedValue({
        id: 's1', dayOfWeek: 2, minAmount: BigInt(10000), isActive: false,
        bankAccountId: 'b1', lastExecutedAt: null, createdAt: new Date(),
      });
      await service.updateSchedule('u1', 's1', { dayOfWeek: 2, minAmount: 100, isActive: false });
      expect(mockPrisma.scheduledWithdrawal.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ dayOfWeek: 2, minAmount: BigInt(10000), isActive: false }),
      }));
    });

    it('rejects an excessive updated schedule minimum instead of storing an unreachable threshold', async () => {
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue({ id: 's1', userId: 'u1', dayOfWeek: 2, minAmount: BigInt(0), isActive: true });

      await expect(service.updateSchedule('u1', 's1', { minAmount: 100_000_001 })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'INVALID_SCHEDULE' }),
      });
      expect(mockPrisma.scheduledWithdrawal.update).not.toHaveBeenCalled();
    });

    it('maps a day-of-week collision to SCHEDULE_ALREADY_EXISTS', async () => {
      mockPrisma.scheduledWithdrawal.findUnique
        .mockResolvedValueOnce({ id: 's1', userId: 'u1', dayOfWeek: 1 })
        .mockResolvedValueOnce({ id: 's2' });

      await expect(service.updateSchedule('u1', 's1', { dayOfWeek: 2 })).rejects.toMatchObject({
        response: { code: 'SCHEDULE_ALREADY_EXISTS' },
      });
      expect(mockPrisma.scheduledWithdrawal.update).not.toHaveBeenCalled();
    });

    it('verifies new bankAccountId belongs to user', async () => {
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue({ userId: 'u1' });
      mockPrisma.bankAccount.findFirst.mockResolvedValue(null);
      await expect(service.updateSchedule('u1', 's1', { bankAccountId: 'bX' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteSchedule', () => {
    it('soft-deactivates owned schedule', async () => {
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue({ userId: 'u1' });
      mockPrisma.scheduledWithdrawal.update.mockResolvedValue({});
      const res = await service.deleteSchedule('u1', 's1');
      expect(res.message).toContain('deactivated');
    });

    it('throws ForbiddenException when not owner', async () => {
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue({ userId: 'other' });
      await expect(service.deleteSchedule('u1', 's1')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('processScheduledWithdrawal', () => {
    it('skips when schedule not found', async () => {
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue(null);
      const res = await service.processScheduledWithdrawal('s1');
      expect(res.skipped).toBe(true);
    });

    it('skips when inactive', async () => {
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue({ isActive: false, user: { isActive: true, isBanned: false } });
      const res = await service.processScheduledWithdrawal('s1');
      expect(res.skipped).toBe(true);
    });

    it('skips when user banned', async () => {
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue({ isActive: true, user: { isActive: true, isBanned: true } });
      const res = await service.processScheduledWithdrawal('s1');
      expect(res.skipped).toBe(true);
    });

    it('skips when no wallet', async () => {
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue({
        userId: 'u1', isActive: true, lastExecutedAt: null, minAmount: BigInt(0),
        user: { isActive: true, isBanned: false }, bankAccount: { accountNumber: 'enc', bankName: 'BCA', isVerified: true },
      });
      mockPrisma.wallet.findUnique.mockResolvedValue(null);
      const res = await service.processScheduledWithdrawal('s1');
      expect(res.skipped).toBe(true);
      expect(res.reason).toContain('Wallet');
    });

    it('skips when the scheduled bank account is unverified', async () => {
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue({
        userId: 'u1', isActive: true, lastExecutedAt: null, minAmount: BigInt(0),
        user: { isActive: true, isBanned: false }, bankAccount: { accountNumber: 'enc', bankName: 'BCA', isVerified: false },
      });
      const res = await service.processScheduledWithdrawal('s1');
      expect(res).toMatchObject({ skipped: true, reason: 'Bank account is not verified' });
      expect(mockPrisma.wallet.findUnique).not.toHaveBeenCalled();
    });

    it('skips when wallet locked', async () => {
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue({
        userId: 'u1', isActive: true, lastExecutedAt: null, minAmount: BigInt(0),
        user: { isActive: true, isBanned: false }, bankAccount: { accountNumber: 'enc', bankName: 'BCA', isVerified: true },
      });
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'w1', isLocked: true, availableBalance: BigInt(10000) });
      const res = await service.processScheduledWithdrawal('s1');
      expect(res.skipped).toBe(true);
    });

    it('skips when balance below minimum', async () => {
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue({
        userId: 'u1', isActive: true, lastExecutedAt: null, minAmount: BigInt(50000),
        user: { isActive: true, isBanned: false }, bankAccount: { accountNumber: 'enc', bankName: 'BCA', isVerified: true },
      });
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'w1', isLocked: false, availableBalance: BigInt(1000) });
      const res = await service.processScheduledWithdrawal('s1');
      expect(res.skipped).toBe(true);
    });

    it('skips when no balance', async () => {
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue({
        userId: 'u1', isActive: true, lastExecutedAt: null, minAmount: BigInt(0),
        user: { isActive: true, isBanned: false }, bankAccount: { accountNumber: 'enc', bankName: 'BCA', isVerified: true },
      });
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'w1', isLocked: false, availableBalance: BigInt(0) });
      const res = await service.processScheduledWithdrawal('s1');
      expect(res.skipped).toBe(true);
    });
  });

  /*
   * WD-01 regression: the automated path previously enforced none of the ceilings the
   * manual path enforces (per-tx max, daily limit, KYC threshold, escrow hold, minimum),
   * because no test ever executed the transaction callback. These tests run it for real.
   */
  describe('processScheduledWithdrawal — limit enforcement inside the transaction', () => {
    const SEN = 100n;

    function arrange(opts: {
      availableBalance: bigint;
      kycStatus?: string;
      todayWithdrawAmount?: bigint;
      heldOrders?: Array<{ sellerReceiveAmount: bigint }>;
      minAmount?: bigint;
      bankAccountExists?: boolean;
      lastLimitResetAt?: Date | null;
    }) {
      mockPrisma.scheduledWithdrawal.findUnique.mockResolvedValue({
        id: 's1', userId: 'u1', bankAccountId: 'b1', isActive: true,
        lastExecutedAt: null, minAmount: opts.minAmount ?? BigInt(0),
        user: { id: 'u1', isActive: true, isBanned: false, kycStatus: opts.kycStatus ?? 'APPROVED' },
        bankAccount: { accountNumber: 'enc1234567890', bankName: 'BCA', isVerified: true },
      });
      const wallet = {
        id: 'w1', isLocked: false, version: 1,
        availableBalance: opts.availableBalance,
        escrowBalance: BigInt(0),
        totalBalance: opts.availableBalance,
        todayWithdrawAmount: opts.todayWithdrawAmount ?? BigInt(0),
        lastLimitResetAt: opts.lastLimitResetAt ?? new Date(),
      };
      mockPrisma.wallet.findUnique.mockResolvedValue(wallet);

      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'w1' }]),
        wallet: {
          findUnique: jest.fn().mockResolvedValue(wallet),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        bankAccount: {
          findFirst: jest.fn().mockResolvedValue(
            opts.bankAccountExists === false ? null : { id: 'b1', userId: 'u1', isVerified: true },
          ),
        },
        order: { findMany: jest.fn().mockResolvedValue(opts.heldOrders ?? []) },
        walletTransaction: { create: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
      return tx;
    }

    it('clamps the amount to the per-transaction maximum', async () => {
      const tx = arrange({ availableBalance: 40_000_000n * SEN });
      const res = await service.processScheduledWithdrawal('s1');
      expect(res.skipped).toBe(false);
      expect(tx.walletTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ amount: 25_000_000n * SEN }),
      }));
    });

    it('clamps the amount to the remaining daily limit', async () => {
      const tx = arrange({
        availableBalance: 20_000_000n * SEN,
        todayWithdrawAmount: 49_000_000n * SEN,
      });
      const res = await service.processScheduledWithdrawal('s1');
      expect(res.skipped).toBe(false);
      expect(tx.walletTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ amount: 1_000_000n * SEN }),
      }));
    });

    it('skips when the daily limit is already exhausted', async () => {
      arrange({ availableBalance: 5_000_000n * SEN, todayWithdrawAmount: 50_000_000n * SEN });
      const res = await service.processScheduledWithdrawal('s1');
      expect(res.skipped).toBe(true);
      expect(res.reason).toContain('Daily withdrawal limit');
    });

    it('clamps a non-KYC user to the KYC-free threshold', async () => {
      const tx = arrange({ availableBalance: 10_000_000n * SEN, kycStatus: 'PENDING' });
      const res = await service.processScheduledWithdrawal('s1');
      expect(res.skipped).toBe(false);
      expect(tx.walletTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ amount: 2_000_000n * SEN }),
      }));
    });

    it('excludes funds still inside the escrow holding period', async () => {
      const tx = arrange({
        availableBalance: 1_000_000n * SEN,
        heldOrders: [{ sellerReceiveAmount: 900_000n * SEN }],
      });
      const res = await service.processScheduledWithdrawal('s1');
      expect(res.skipped).toBe(false);
      expect(tx.walletTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ amount: 100_000n * SEN }),
      }));
    });

    it('skips when escrow hold leaves less than the user configured schedule minimum', async () => {
      arrange({
        availableBalance: 600_000n * SEN,
        minAmount: 500_000n * SEN,
        heldOrders: [{ sellerReceiveAmount: 400_000n * SEN }],
      });

      const res = await service.processScheduledWithdrawal('s1');

      expect(res).toMatchObject({ skipped: true, reason: 'Balance below the schedule minimum' });
      expect(mockSerial.getNext).not.toHaveBeenCalled();
    });

    it('skips when the entire balance is held in escrow', async () => {
      arrange({
        availableBalance: 500_000n * SEN,
        heldOrders: [{ sellerReceiveAmount: 500_000n * SEN }],
      });
      const res = await service.processScheduledWithdrawal('s1');
      expect(res.skipped).toBe(true);
      expect(res.reason).toContain('escrow');
    });

    it('skips when the withdrawable amount is below the minimum withdrawal', async () => {
      arrange({ availableBalance: 20_000n * SEN });
      const res = await service.processScheduledWithdrawal('s1');
      expect(res.skipped).toBe(true);
      expect(res.reason).toContain('minimum');
    });

    it('skips when the bank account was deleted after the schedule was created', async () => {
      arrange({ availableBalance: 1_000_000n * SEN, bankAccountExists: false });
      const res = await service.processScheduledWithdrawal('s1');
      expect(res.skipped).toBe(true);
      expect(res.reason).toContain('Bank account');
    });

    it('does not allocate a wallet ledger serial when another worker already claimed this schedule period', async () => {
      const tx = arrange({ availableBalance: 1_000_000n * SEN });
      tx.$executeRaw.mockResolvedValue(0);

      const res = await service.processScheduledWithdrawal('s1');

      expect(res).toMatchObject({ skipped: true, reason: 'Already processed for the current period' });
      expect(mockSerial.getNext).not.toHaveBeenCalled();
      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('does not allocate a wallet ledger serial when an in-transaction guard skips the run', async () => {
      arrange({ availableBalance: 500_000n * SEN, heldOrders: [{ sellerReceiveAmount: 500_000n * SEN }] });

      const res = await service.processScheduledWithdrawal('s1');

      expect(res.skipped).toBe(true);
      expect(mockSerial.getNext).not.toHaveBeenCalled();
    });

    it('resets the daily counter lazily when the last reset predates today (WIB)', async () => {
      const tx = arrange({
        availableBalance: 1_000_000n * SEN,
        todayWithdrawAmount: 50_000_000n * SEN,
        lastLimitResetAt: new Date('2020-01-01T00:00:00Z'),
      });
      const res = await service.processScheduledWithdrawal('s1');
      expect(res.skipped).toBe(false);
      expect(tx.wallet.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          todayWithdrawAmount: 1_000_000n * SEN,
          todayTopupAmount: 0n,
        }),
      }));
    });

    it('records balanceBefore/After against the clamped amount', async () => {
      const tx = arrange({ availableBalance: 40_000_000n * SEN });
      await service.processScheduledWithdrawal('s1');
      expect(tx.walletTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          balanceBefore: 40_000_000n * SEN,
          balanceAfter: 15_000_000n * SEN,
        }),
      }));
    });
  });
});
