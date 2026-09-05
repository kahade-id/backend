import { PrismaService } from '../../prisma/prisma.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { FeeCalculatorService } from '../orders/fee-calculator.service';
export declare class MutualResolutionService {
    private prisma;
    private walletTxSerialService;
    private feeCalculator;
    private readonly logger;
    constructor(prisma: PrismaService, walletTxSerialService: WalletTxSerialService, feeCalculator: FeeCalculatorService);
    propose(disputeId: string, userId: string, dto: {
        buyerPercent: number;
        sellerPercent: number;
        reason: string;
    }): Promise<object>;
    respond(disputeId: string, proposalId: string, userId: string, action: 'ACCEPT' | 'REJECT', responseNote?: string): Promise<object>;
    private runPostCommitBestEffort;
    private runRealtimeBestEffort;
    private withSerializableRetry;
    private isRetryableDbError;
    getProposals(disputeId: string, userId: string, page?: number, limit?: number): Promise<object>;
    withdraw(disputeId: string, proposalId: string, userId: string): Promise<{
        status: string;
    }>;
}
