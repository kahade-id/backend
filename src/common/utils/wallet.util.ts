import { Prisma } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import * as ErrorCodes from '../constants/error-codes';

export interface WalletBalanceUpdate {
  availableBalance?: { increment?: bigint | number; decrement?: bigint | number };
  escrowBalance?: { increment?: bigint | number; decrement?: bigint | number };
  totalBalance?: { increment?: bigint | number; decrement?: bigint | number };
  todayTopupAmount?: bigint | { increment: bigint };
  todayWithdrawAmount?: bigint | { increment: bigint };
  lastLimitResetAt?: Date;
  isLocked?: boolean;
}

export async function updateWalletWithVersion(
  tx: Prisma.TransactionClient,
  walletId: string,
  currentVersion: number,
  data: WalletBalanceUpdate,
  context?: string,
): Promise<void> {
  const result = await tx.wallet.updateMany({
    where: { id: walletId, version: currentVersion },
    data: {
      ...data,
      version: { increment: 1 },
    },
  });

  if (result.count === 0) {
    throw new ConflictException({
      code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
      message: `Concurrent wallet update detected${context ? ` (${context})` : ''}, please retry`,
    });
  }
}
