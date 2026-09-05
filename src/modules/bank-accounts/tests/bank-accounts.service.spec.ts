import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BankAccountsService } from '../bank-accounts.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { MidtransService } from '../../payment/midtrans.service';
import { BankCode, Prisma } from '@prisma/client';
import { initializeCrypto } from '../../../common/utils/crypto.util';

beforeAll(() => {
  initializeCrypto({
    aesSecretKey: '0'.repeat(64),
    hmacSecretKey: '1'.repeat(64),
    bcryptRounds: 4,
  });
});

const mockPrisma = {
  bankAccount: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  user: { findUnique: jest.fn() },
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
};

const mockMidtrans = {
  validateBankAccount: jest
    .fn()
    .mockResolvedValue({ accountName: 'BUDI SANTOSO', accountNumber: '1234567890' }),
  inquireBankAccount: jest.fn().mockResolvedValue({
    accountName: 'BUDI SANTOSO',
    accountNo: '1234567890',
    bankCode: BankCode.BCA,
  }),
};

const mockConfig = {
  get: jest.fn((k: string) => {
    const v: Record<string, unknown> = {
      'crypto.aesKey': '0'.repeat(64),
      'crypto.hmacKey': '0'.repeat(64),
    };
    return v[k];
  }),
};

describe('BankAccountsService', () => {
  let service: BankAccountsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BankAccountsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MidtransService, useValue: mockMidtrans },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get<BankAccountsService>(BankAccountsService);
  });

  describe('addBankAccount — Indonesian bank account number length validation', () => {
    it('REJECTS BCA account with 9 digits (must be exactly 10)', async () => {
      mockPrisma.bankAccount.count.mockResolvedValue(0);
      mockPrisma.bankAccount.findFirst.mockResolvedValue(null);
      await expect(
        service.addBankAccount('user-1', BankCode.BCA, 'BCA', '123456789', 'BUDI SANTOSO'),
      ).rejects.toMatchObject({ response: { code: 'BANK_ACCOUNT_NUMBER_LENGTH' } });
    });

    it('REJECTS BCA account with 11 digits (must be exactly 10)', async () => {
      mockPrisma.bankAccount.count.mockResolvedValue(0);
      mockPrisma.bankAccount.findFirst.mockResolvedValue(null);
      await expect(
        service.addBankAccount('user-1', BankCode.BCA, 'BCA', '12345678901', 'BUDI SANTOSO'),
      ).rejects.toMatchObject({ response: { code: 'BANK_ACCOUNT_NUMBER_LENGTH' } });
    });

    it('REJECTS MAYBANK account outside 12-digit length', async () => {
      mockPrisma.bankAccount.count.mockResolvedValue(0);
      mockPrisma.bankAccount.findFirst.mockResolvedValue(null);
      await expect(
        service.addBankAccount(
          'user-1',
          BankCode.MAYBANK,
          'MAYBANK',
          '12345678901',
          'BUDI SANTOSO',
        ),
      ).rejects.toMatchObject({ response: { code: 'BANK_ACCOUNT_NUMBER_LENGTH' } });
    });

    it('ACCEPTS BRI 12-digit account on length validator', async () => {
      // Force a downstream error so we know length validation passed without
      // having to mock the entire create transaction.
      mockPrisma.bankAccount.count.mockResolvedValue(0);
      mockPrisma.bankAccount.findFirst.mockResolvedValue({ userId: 'someone-else' });
      await expect(
        service.addBankAccount('user-1', BankCode.BRI, 'BRI', '123456789012', 'BUDI SANTOSO'),
      ).rejects.not.toMatchObject({ response: { code: 'BANK_ACCOUNT_NUMBER_LENGTH' } });
    });
  });

  describe('deleteBankAccount — cross-user authorization', () => {
    it('THROWS NotFoundException when account does not belong to user', async () => {
      mockPrisma.$transaction.mockImplementation(async cb =>
        cb({
          $queryRaw: jest
            .fn()
            .mockResolvedValue([{ id: 'ba-other', userId: 'attacker', deletedAt: null }]),
          bankAccount: { update: jest.fn(), updateMany: jest.fn() },
          withdrawal: { count: jest.fn().mockResolvedValue(0) },
        }),
      );
      await expect(service.deleteBankAccount('victim', 'ba-other')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('setPrimaryBankAccount — verification guard', () => {
    it('rejects an unverified account before clearing the existing primary', async () => {
      const updateMany = jest.fn();
      mockPrisma.$transaction.mockImplementation(async cb =>
        cb({
          $queryRaw: jest.fn().mockResolvedValue([{ id: 'ba-1' }]),
          bankAccount: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'ba-1',
              userId: 'user-1',
              deletedAt: null,
              isVerified: false,
            }),
            updateMany,
            update: jest.fn(),
          },
        }),
      );
      await expect(service.setPrimaryBankAccount('user-1', 'ba-1')).rejects.toMatchObject({
        response: { code: 'BANK_ACCOUNT_NOT_VERIFIED' },
      });
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('locks all active accounts before clearing and replacing the primary account', async () => {
      const queryRaw = jest.fn().mockResolvedValue([{ id: 'ba-1' }, { id: 'ba-2' }]);
      const updateMany = jest.fn().mockResolvedValue({ count: 2 });
      const update = jest.fn().mockResolvedValue({
        id: 'ba-2',
        bankCode: 'BCA',
        bankName: 'BCA',
        accountName: 'BUDI SANTOSO',
        isPrimary: true,
      });
      mockPrisma.$transaction.mockImplementation(async cb =>
        cb({
          $queryRaw: queryRaw,
          bankAccount: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'ba-2',
              userId: 'user-1',
              deletedAt: null,
              isVerified: true,
            }),
            updateMany,
            update,
          },
        }),
      );

      await expect(service.setPrimaryBankAccount('user-1', 'ba-2')).resolves.toMatchObject({
        id: 'ba-2',
        isPrimary: true,
      });
      expect(queryRaw).toHaveBeenCalledTimes(1);
      expect(updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', deletedAt: null },
        data: { isPrimary: false },
      });
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'ba-2' }, data: { isPrimary: true } }),
      );
    });
  });

  describe('addBankAccount — duplicate per user', () => {
    it('REJECTS adding a bank account that already exists for the same user', async () => {
      mockPrisma.bankAccount.count.mockResolvedValue(0);
      mockPrisma.bankAccount.findFirst.mockResolvedValue({
        userId: 'user-1',
        accountNumberHash: 'h',
      });
      await expect(
        service.addBankAccount('user-1', BankCode.BCA, 'BCA', '1234567890', 'BUDI SANTOSO'),
      ).rejects.toMatchObject({ response: { code: expect.stringMatching(/EXISTS|DUPLICATE/) } });
    });
  });

  describe('deleteBankAccount — pending withdrawal guard', () => {
    it('REJECTS deletion when a withdrawal is PENDING_PROCESS / PROCESSING / PENDING_OTP', async () => {
      mockPrisma.$transaction.mockImplementation(async cb =>
        cb({
          $queryRaw: jest
            .fn()
            .mockResolvedValue([
              { id: 'ba-1', userId: 'user-1', deletedAt: null, isPrimary: false },
            ]),
          bankAccount: {
            update: jest.fn(),
            updateMany: jest.fn(),
          },
          walletTransaction: {
            findFirst: jest.fn().mockResolvedValue({ id: 'wtx-1' }),
          },
          scheduledWithdrawal: { updateMany: jest.fn() },
        }),
      );
      await expect(service.deleteBankAccount('user-1', 'ba-1')).rejects.toMatchObject({
        response: { code: 'BANK_ACCOUNT_HAS_PENDING_WITHDRAWAL' },
      });
    });

    it('REJECTS deletion of the primary account BEFORE the withdrawal check is reached', async () => {
      // Spy both the soft-delete update AND the pending-withdrawal lookup.
      // The primary guard must short-circuit BEFORE either is evaluated, so an
      // attacker cannot infer pending-withdrawal state via timing/error-shape.
      const updateSpy = jest.fn();
      const pendingLookupSpy = jest.fn();
      mockPrisma.$transaction.mockImplementation(async cb =>
        cb({
          $queryRaw: jest
            .fn()
            .mockResolvedValue([
              { id: 'ba-primary', userId: 'user-1', deletedAt: null, isPrimary: true },
            ]),
          bankAccount: { update: updateSpy, updateMany: jest.fn() },
          walletTransaction: { findFirst: pendingLookupSpy },
          scheduledWithdrawal: { updateMany: jest.fn() },
        }),
      );
      await expect(service.deleteBankAccount('user-1', 'ba-primary')).rejects.toMatchObject({
        response: { code: 'CANNOT_DELETE_PRIMARY_BANK' },
      });
      expect(updateSpy).not.toHaveBeenCalled();
      expect(pendingLookupSpy).not.toHaveBeenCalled();
    });
  });

  /*
   * BA-01 / BA-02 regression.
   *
   * `accountNumberHash` has a GLOBAL unique index (migration 20260308201139_init line
   * 1052 — no `deletedAt` predicate), but every app-level duplicate check is scoped to
   * `deletedAt: null`. A soft-deleted row keeps its hash, so re-adding an account the
   * user had deleted passed the check and then died on the constraint: a bare 409
   * DUPLICATE_ENTRY, and that account number was locked out of the platform forever —
   * for its own owner included. The cap check and the write also used to sit outside any
   * transaction, so concurrent adds could both pass a stale count.
   */
  describe('addBankAccount — soft-deleted hash collision and cap atomicity', () => {
    const HASH_OWNER = 'user-1';

    function arrangeTx(opts: {
      inTxCount?: number;
      existing?: { id: string; userId: string; deletedAt: Date | null } | null;
      createRejectsP2002?: boolean;
    }) {
      const create = jest.fn();
      if (opts.createRejectsP2002) {
        create.mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: '5.0.0',
          }),
        );
      } else {
        create.mockResolvedValue({ id: 'ba-new', isPrimary: true, isVerified: false });
      }
      const update = jest
        .fn()
        .mockResolvedValue({ id: 'ba-revived', isPrimary: true, isVerified: false });
      const tx = {
        bankAccount: {
          count: jest.fn().mockResolvedValue(opts.inTxCount ?? 0),
          findFirst: jest.fn().mockResolvedValue(opts.existing ?? null),
          create,
          update,
        },
      };
      mockPrisma.$transaction.mockImplementation(async cb => cb(tx));
      return tx;
    }

    // Pre-check state shared by every case here: under the cap, no *active* duplicate.
    function arrangePreChecks() {
      mockPrisma.bankAccount.count.mockResolvedValue(0);
      mockPrisma.bankAccount.findFirst.mockResolvedValue(null);
    }

    it('revives the caller own soft-deleted account instead of colliding on the index', async () => {
      arrangePreChecks();
      const tx = arrangeTx({
        existing: { id: 'ba-old', userId: HASH_OWNER, deletedAt: new Date('2026-07-01') },
      });

      await service.addBankAccount(HASH_OWNER, BankCode.BCA, 'BCA', '1234567890', 'BUDI SANTOSO');

      expect(tx.bankAccount.create).not.toHaveBeenCalled();
      expect(tx.bankAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ba-old' },
          data: expect.objectContaining({ deletedAt: null }),
        }),
      );
    });

    it('re-encrypts the account name and bank on revive rather than keeping stale data', async () => {
      arrangePreChecks();
      const tx = arrangeTx({
        existing: { id: 'ba-old', userId: HASH_OWNER, deletedAt: new Date('2026-07-01') },
      });

      await service.addBankAccount(HASH_OWNER, BankCode.BCA, 'BCA', '1234567890', 'BUDI SANTOSO');

      const data = tx.bankAccount.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.bankCode).toBe(BankCode.BCA);
      expect(data.bankName).toBe('BCA');
      // Encrypted, so not the plaintext — but present and non-empty.
      expect(typeof data.accountName).toBe('string');
      expect(data.accountName).not.toBe('BUDI SANTOSO');
      expect(typeof data.accountNumber).toBe('string');
      expect(data.accountNumber).not.toBe('1234567890');
    });

    it('makes a revived account primary only when it is the user only account', async () => {
      arrangePreChecks();
      const soleTx = arrangeTx({
        inTxCount: 0,
        existing: { id: 'ba-old', userId: HASH_OWNER, deletedAt: new Date('2026-07-01') },
      });
      await service.addBankAccount(HASH_OWNER, BankCode.BCA, 'BCA', '1234567890', 'BUDI SANTOSO');
      expect(
        (soleTx.bankAccount.update.mock.calls[0][0].data as { isPrimary: boolean }).isPrimary,
      ).toBe(true);

      const secondTx = arrangeTx({
        inTxCount: 2,
        existing: { id: 'ba-old', userId: HASH_OWNER, deletedAt: new Date('2026-07-01') },
      });
      await service.addBankAccount(HASH_OWNER, BankCode.BCA, 'BCA', '1234567890', 'BUDI SANTOSO');
      expect(
        (secondTx.bankAccount.update.mock.calls[0][0].data as { isPrimary: boolean }).isPrimary,
      ).toBe(false);
    });

    it('rejects with BANK_ACCOUNT_DUPLICATE when another user holds the soft-deleted hash', async () => {
      arrangePreChecks();
      const tx = arrangeTx({
        existing: { id: 'ba-other', userId: 'someone-else', deletedAt: new Date('2026-07-01') },
      });

      await expect(
        service.addBankAccount(HASH_OWNER, BankCode.BCA, 'BCA', '1234567890', 'BUDI SANTOSO'),
      ).rejects.toMatchObject({ response: { code: 'BANK_ACCOUNT_DUPLICATE' } });
      expect(tx.bankAccount.create).not.toHaveBeenCalled();
      expect(tx.bankAccount.update).not.toHaveBeenCalled();
    });

    it('rejects an active duplicate found only inside the transaction', async () => {
      arrangePreChecks();
      const tx = arrangeTx({ existing: { id: 'ba-live', userId: HASH_OWNER, deletedAt: null } });

      await expect(
        service.addBankAccount(HASH_OWNER, BankCode.BCA, 'BCA', '1234567890', 'BUDI SANTOSO'),
      ).rejects.toMatchObject({ response: { code: 'BANK_ACCOUNT_DUPLICATE' } });
      expect(tx.bankAccount.create).not.toHaveBeenCalled();
    });

    it('re-checks the account cap inside the transaction against a stale pre-check', async () => {
      // Pre-check saw room; a concurrent add filled the last slot in the meantime.
      arrangePreChecks();
      const tx = arrangeTx({ inTxCount: 5 });

      await expect(
        service.addBankAccount(HASH_OWNER, BankCode.BCA, 'BCA', '1234567890', 'BUDI SANTOSO'),
      ).rejects.toMatchObject({ response: { code: 'MAX_BANK_ACCOUNTS_REACHED' } });
      expect(tx.bankAccount.create).not.toHaveBeenCalled();
    });

    it('maps a residual P2002 to BANK_ACCOUNT_DUPLICATE, not the generic 409', async () => {
      arrangePreChecks();
      arrangeTx({ createRejectsP2002: true });

      await expect(
        service.addBankAccount(HASH_OWNER, BankCode.BCA, 'BCA', '1234567890', 'BUDI SANTOSO'),
      ).rejects.toMatchObject({ response: { code: 'BANK_ACCOUNT_DUPLICATE' } });
    });

    it('rejects a provider account-number mismatch before persisting verification', async () => {
      arrangePreChecks();
      arrangeTx({ existing: null });
      mockMidtrans.inquireBankAccount.mockResolvedValueOnce({
        accountName: 'BUDI SANTOSO',
        accountNo: '9999999999',
        bankCode: BankCode.BCA,
      });

      await expect(
        service.addBankAccount(HASH_OWNER, BankCode.BCA, 'BCA', '1234567890', 'BUDI SANTOSO'),
      ).rejects.toMatchObject({ response: { code: 'BANK_ACCOUNT_NUMBER_MISMATCH' } });
    });

    it('inserts normally when the hash is unused', async () => {
      arrangePreChecks();
      const tx = arrangeTx({ existing: null });

      await service.addBankAccount(HASH_OWNER, BankCode.BCA, 'BCA', '1234567890', 'BUDI SANTOSO');

      expect(tx.bankAccount.update).not.toHaveBeenCalled();
      expect(tx.bankAccount.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: HASH_OWNER, isPrimary: true }),
        }),
      );
    });
  });

  void BadRequestException;
});
