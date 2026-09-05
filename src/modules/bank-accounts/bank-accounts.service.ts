import {
  Prisma,
  BankCode,
  WithdrawStatus,
  WalletTransactionStatus,
  WalletTransactionType,
} from '@prisma/client';
import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { MidtransService } from '../payment/midtrans.service';
import { encryptAES, hmacSHA256, decryptAES } from '../../common/utils/crypto.util';
import * as ErrorCodes from '../../common/constants/error-codes';
import { MAX_BANK_ACCOUNTS } from '../../common/constants/app.constants';

const BANK_ACCOUNT_LENGTH: Partial<Record<BankCode, { min: number; max: number }>> = {
  [BankCode.BCA]: { min: 10, max: 10 },
  [BankCode.BNI]: { min: 10, max: 10 },
  [BankCode.BRI]: { min: 10, max: 15 },
  [BankCode.MANDIRI]: { min: 10, max: 13 },
  [BankCode.CIMB]: { min: 10, max: 13 },
  [BankCode.BSI]: { min: 10, max: 12 },
  [BankCode.MAYBANK]: { min: 12, max: 12 },
};

function validateBankAccountLength(bankCode: string, accountNumber: string): void {
  const rule = BANK_ACCOUNT_LENGTH[bankCode as BankCode];
  if (!rule) return; // no per-bank constraint — DTO 6–20 check is sufficient
  const len = accountNumber.length;
  if (len < rule.min || len > rule.max) {
    const rangeDesc = rule.min === rule.max ? `${rule.min}` : `${rule.min}–${rule.max}`;
    throw new BadRequestException({
      code: 'BANK_ACCOUNT_NUMBER_LENGTH',
      message: `Account number for ${bankCode} must be ${rangeDesc} digits (received: ${len} digits)`,
    });
  }
}

const MAX_NAME_LENGTH_FOR_SIMILARITY = 100;

function nameSimilarity(a: string, b: string): number {
  const na = a.toUpperCase().trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH_FOR_SIMILARITY);
  const nb = b.toUpperCase().trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH_FOR_SIMILARITY);
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  const matrix: number[][] = [];
  for (let i = 0; i <= na.length; i++) {
    matrix[i] = [i];
    for (let j = 1; j <= nb.length; j++) {
      if (i === 0) {
        matrix[i][j] = j;
      } else {
        const cost = na[i - 1] === nb[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost,
        );
      }
    }
  }
  return 1 - matrix[na.length][nb.length] / maxLen;
}

const NAME_SIMILARITY_THRESHOLD = 0.8;

@Injectable()
export class BankAccountsService {
  private readonly logger = new Logger(BankAccountsService.name);

  constructor(
    private prisma: PrismaService,
    private midtransService: MidtransService,
    private configService: ConfigService,
  ) {}

  async listBankAccounts(
    userId: string,
  ): Promise<{ bankAccounts: Array<Record<string, unknown>> }> {
    const accounts = await this.prisma.bankAccount.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        bankCode: true,
        bankName: true,
        accountName: true,
        accountNumber: true, // encrypted — decrypted below for masking
        isPrimary: true,
        isVerified: true,
        createdAt: true,
      },
      take: MAX_BANK_ACCOUNTS,
    });

    const result = await Promise.all(
      accounts.map(async acc => {
        let maskedAccountNumber = '****';
        let decryptedAccountName = 'Bank account';
        try {
          const plain = await decryptAES(acc.accountNumber);
          maskedAccountNumber = `****${plain.slice(-4)}`;
        } catch {
          // leave default mask if decryption unexpectedly fails
        }
        try {
          decryptedAccountName = await decryptAES(acc.accountName);
        } catch {
          // fallback: accountName may not be encrypted yet (pre-migration data)
        }
        const { accountNumber: _omit, accountName: _omitName, ...rest } = acc;
        return { ...rest, accountName: decryptedAccountName, maskedAccountNumber };
      }),
    );

    return { bankAccounts: result };
  }

  async addBankAccount(
    userId: string,
    bankCode: string,
    bankName: string,
    accountNumber: string,
    accountName: string,
  ): Promise<Record<string, unknown>> {
    const existingCount = await this.prisma.bankAccount.count({
      where: { userId, deletedAt: null },
    });

    if (existingCount >= MAX_BANK_ACCOUNTS) {
      throw new BadRequestException({
        code: ErrorCodes.MAX_BANK_ACCOUNTS_REACHED,
        message: `Maximum of ${MAX_BANK_ACCOUNTS} bank accounts allowed`,
      });
    }

    const normalizedAccountNumber = accountNumber.trim().replace(/\s+/g, '');
    validateBankAccountLength(bankCode, normalizedAccountNumber);
    const accountNumberHash = hmacSHA256(`${bankCode}:${normalizedAccountNumber}`);

    // Cheap pre-check so an obvious duplicate fails before the Midtrans round-trip.
    // The authoritative check runs inside the transaction below.
    const duplicate = await this.prisma.bankAccount.findFirst({
      where: { accountNumberHash, deletedAt: null },
      select: { userId: true },
    });
    if (duplicate) {
      throw new BadRequestException({
        code: 'BANK_ACCOUNT_DUPLICATE',
        message: 'This bank account is already registered',
      });
    }

    let verifiedAccountName = accountName;
    let isVerified = false;
    const nodeEnv = this.configService.get<string>('app.nodeEnv') ?? 'development';
    const skipVerification =
      nodeEnv !== 'production' &&
      (this.configService.get<boolean>('app.skipBankVerification') ?? false);

    if (!skipVerification) {
      try {
        const inquiry = await this.midtransService.inquireBankAccount(
          bankCode,
          normalizedAccountNumber,
        );
        const returnedAccountNumber = String(inquiry.accountNo ?? '')
          .trim()
          .replace(/\s+/g, '');
        if (!returnedAccountNumber || returnedAccountNumber !== normalizedAccountNumber) {
          this.logger.error(
            `Bank inquiry account number mismatch for bank=${bankCode}; refusing verification`,
          );
          throw new BadRequestException({
            code: 'BANK_ACCOUNT_NUMBER_MISMATCH',
            message: 'Bank account verification response does not match the requested account.',
          });
        }
        verifiedAccountName = inquiry.accountName;

        const similarity = nameSimilarity(accountName, verifiedAccountName);
        this.logger.log(
          `Bank account name similarity: ${(similarity * 100).toFixed(1)}% for bank=${bankCode}`,
        );

        if (similarity < NAME_SIMILARITY_THRESHOLD) {
          throw new BadRequestException({
            code: 'BANK_ACCOUNT_NAME_MISMATCH',
            message: 'Account name does not match bank records',
          });
        }

        isVerified = true;
      } catch (err) {
        if (err instanceof BadRequestException) {
          throw err;
        }
        this.logger.warn(
          `Bank verification unavailable, adding unverified account: ${(err as Error).message}`,
        );
        isVerified = false;
      }
    }

    const encryptedAccountNumber = await encryptAES(normalizedAccountNumber);
    const encryptedAccountName = await encryptAES(verifiedAccountName);

    /*
     * BA-01/BA-02: the cap check, the duplicate resolution and the write have to be one
     * atomic unit. The Midtrans inquiry above stays outside it — a network round-trip must
     * never be held inside a Serializable transaction.
     *
     * BA-01: `accountNumberHash` carries a *global* unique index (no `deletedAt` predicate,
     * see migration 20260308201139_init), while every application-level duplicate check is
     * scoped to `deletedAt: null`. A soft-deleted row therefore keeps its hash and stays
     * invisible to the check but still owns the index entry, so re-adding an account the
     * user had previously deleted slipped past the check and died on the constraint —
     * surfacing as a bare 409 DUPLICATE_ENTRY and locking that account number out of the
     * platform permanently, for its rightful owner included. Reviving the caller's own
     * soft-deleted row is the fix; withdrawal history stays attached to it.
     */
    const SELECT_SHAPE = {
      id: true,
      bankCode: true,
      bankName: true,
      accountName: true,
      isPrimary: true,
      isVerified: true,
      createdAt: true,
    } as const;

    const created = await this.prisma
      .$transaction(
        async (tx: Prisma.TransactionClient) => {
          // Re-count inside the transaction: the pre-check above cannot stop two concurrent
          // adds from both observing MAX-1 and both inserting.
          const activeCount = await tx.bankAccount.count({ where: { userId, deletedAt: null } });
          if (activeCount >= MAX_BANK_ACCOUNTS) {
            throw new BadRequestException({
              code: ErrorCodes.MAX_BANK_ACCOUNTS_REACHED,
              message: `Maximum of ${MAX_BANK_ACCOUNTS} bank accounts allowed`,
            });
          }

          // Unscoped by deletedAt on purpose — this mirrors what the unique index enforces.
          const existing = await tx.bankAccount.findFirst({
            where: { accountNumberHash },
            select: { id: true, userId: true, deletedAt: true },
          });

          // Anyone else holding the number blocks it, active or soft-deleted: one bank
          // account belongs to exactly one wallet. Raised as the specific 400 rather than
          // being left to the constraint's opaque 409.
          if (existing && (existing.deletedAt === null || existing.userId !== userId)) {
            throw new BadRequestException({
              code: 'BANK_ACCOUNT_DUPLICATE',
              message: 'This bank account is already registered',
            });
          }

          const isFirstAccount = activeCount === 0;

          if (existing) {
            return tx.bankAccount.update({
              where: { id: existing.id },
              data: {
                deletedAt: null,
                bankCode: bankCode as BankCode,
                bankName,
                accountNumber: encryptedAccountNumber,
                accountName: encryptedAccountName,
                isPrimary: isFirstAccount && isVerified,
                isVerified,
              },
              select: SELECT_SHAPE,
            });
          }

          return tx.bankAccount.create({
            data: {
              userId,
              bankCode: bankCode as BankCode,
              bankName,
              accountNumber: encryptedAccountNumber,
              accountNumberHash,
              accountName: encryptedAccountName,
              isPrimary: isFirstAccount && isVerified,
              isVerified,
            },
            select: SELECT_SHAPE,
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .catch((err: unknown) => {
        // Last line of defence for a concurrent insert that beat this transaction to the
        // index: report the real reason instead of the generic DUPLICATE_ENTRY 409.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BadRequestException({
            code: 'BANK_ACCOUNT_DUPLICATE',
            message: 'This bank account is already registered',
          });
        }
        throw err;
      });

    return { ...created, accountName: verifiedAccountName };
  }

  async deleteBankAccount(userId: string, bankAccountId: string): Promise<{ message: string }> {
    await this.prisma.$transaction(
      async tx => {
        const locked = await tx.$queryRaw<
          Array<{ id: string; userId: string; isPrimary: boolean; deletedAt: Date | null }>
        >`
        SELECT id, "userId", "isPrimary", "deletedAt" FROM bank_accounts
        WHERE id = ${bankAccountId} FOR UPDATE
      `;
        const account = locked[0];

        if (!account || account.userId !== userId || account.deletedAt !== null) {
          throw new NotFoundException({
            code: ErrorCodes.BANK_ACCOUNT_NOT_FOUND,
            message: 'Bank account not found',
          });
        }

        if (account.isPrimary) {
          throw new BadRequestException({
            code: ErrorCodes.CANNOT_DELETE_PRIMARY_BANK,
            message: 'Cannot delete primary bank account. Set another account as primary first.',
          });
        }

        const pendingWithdrawal = await tx.walletTransaction.findFirst({
          where: {
            bankAccountId,
            type: WalletTransactionType.WITHDRAW,
            status: { in: [WalletTransactionStatus.PENDING, WalletTransactionStatus.SUCCESS] },
            withdrawStatus: {
              in: [
                WithdrawStatus.PENDING_OTP,
                WithdrawStatus.PENDING_PROCESS,
                WithdrawStatus.PROCESSING,
              ],
            },
          },
          select: { id: true },
        });

        if (pendingWithdrawal) {
          throw new BadRequestException({
            code: ErrorCodes.BANK_ACCOUNT_HAS_PENDING_WITHDRAWAL,
            message: 'Cannot delete bank account while a withdrawal is pending or being processed.',
          });
        }

        await tx.bankAccount.update({
          where: { id: bankAccountId },
          data: { deletedAt: new Date() },
        });

        await tx.scheduledWithdrawal.updateMany({
          where: { bankAccountId, isActive: true },
          data: { isActive: false },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return { message: 'Bank account deleted' };
  }

  async setPrimaryBankAccount(
    userId: string,
    bankAccountId: string,
  ): Promise<Record<string, unknown>> {
    return this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        // Serialize primary-account changes for the same user. Without locking the
        // active set, two concurrent requests can both clear the old primary and
        // then each mark a different account as primary.
        await tx.$queryRaw`
        SELECT id FROM bank_accounts
        WHERE "userId" = ${userId} AND "deletedAt" IS NULL
        ORDER BY id
        FOR UPDATE
      `;
        const account = await tx.bankAccount.findFirst({
          where: { id: bankAccountId, userId, deletedAt: null },
        });

        if (!account) {
          throw new NotFoundException({
            code: ErrorCodes.BANK_ACCOUNT_NOT_FOUND,
            message: 'Bank account not found',
          });
        }
        if (!account.isVerified) {
          throw new BadRequestException({
            code: ErrorCodes.BANK_ACCOUNT_NOT_VERIFIED,
            message:
              'Bank account must be verified before it can be used as the primary payout account',
          });
        }

        await tx.bankAccount.updateMany({
          where: { userId, deletedAt: null },
          data: { isPrimary: false },
        });

        const updated = await tx.bankAccount.update({
          where: { id: bankAccountId },
          data: { isPrimary: true },
          select: { id: true, bankCode: true, bankName: true, accountName: true, isPrimary: true },
        });
        let decryptedName = updated.accountName;
        try {
          decryptedName = await decryptAES(updated.accountName);
        } catch {
          /* pre-migration data */
        }
        return { ...updated, accountName: decryptedName };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
