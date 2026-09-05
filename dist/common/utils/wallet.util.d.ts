import { Prisma } from '@prisma/client';
export interface WalletBalanceUpdate {
    availableBalance?: {
        increment?: bigint | number;
        decrement?: bigint | number;
    };
    escrowBalance?: {
        increment?: bigint | number;
        decrement?: bigint | number;
    };
    totalBalance?: {
        increment?: bigint | number;
        decrement?: bigint | number;
    };
    todayTopupAmount?: bigint | {
        increment: bigint;
    };
    todayWithdrawAmount?: bigint | {
        increment: bigint;
    };
    lastLimitResetAt?: Date;
    isLocked?: boolean;
}
export declare function updateWalletWithVersion(tx: Prisma.TransactionClient, walletId: string, currentVersion: number, data: WalletBalanceUpdate, context?: string): Promise<void>;
