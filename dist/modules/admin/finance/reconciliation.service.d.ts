import { PrismaService } from '../../../prisma/prisma.service';
export interface WalletDiscrepancy {
    walletId: string;
    userId: string;
    actualAvailable: number;
    actualEscrow: number;
    actualTotal: number;
    expectedTotal: number;
    discrepancy: number;
    invariantViolation: boolean;
}
export interface ReconciliationResult {
    reconciledAt: string;
    walletsChecked: number;
    discrepancies: WalletDiscrepancy[];
    clean: boolean;
}
export interface AuditTrailRow {
    txId: string;
    type: string;
    status: string;
    amount: number;
    balanceBefore: number;
    balanceAfter: number;
    totalBalanceDelta: number;
    runningTotalBalance: number;
    description: string;
    createdAt: Date;
}
export interface AuditTrailResult {
    userId: string;
    from: string;
    to: string;
    openingTotalBalance: number;
    closingTotalBalance: number;
    transactions: AuditTrailRow[];
}
export declare class ReconciliationService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    reconcileWalletBalance(userId: string): Promise<WalletDiscrepancy | null>;
    reconcileAllWallets(): Promise<ReconciliationResult>;
    getFinancialAuditTrail(userId: string, from: string, to: string): Promise<AuditTrailResult>;
    private computeTotalBalanceDelta;
    private reconcileWallet;
}
