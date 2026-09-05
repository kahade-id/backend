import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { ReferralService } from '../../referral/referral.service';
import { MembershipRankService } from '../../orders/membership-rank.service';
import { FeeCalculatorService } from '../../orders/fee-calculator.service';
export declare class AutoCompleteDeliveredOrdersService {
    private prisma;
    private redis;
    private walletTxSerialService;
    private referralService;
    private membershipRankService;
    private feeCalculator;
    private readonly logger;
    constructor(prisma: PrismaService, redis: RedisService, walletTxSerialService: WalletTxSerialService, referralService: ReferralService, membershipRankService: MembershipRankService, feeCalculator: FeeCalculatorService);
    private runRealtimeBestEffort;
    autoComplete(): Promise<void>;
    private withSerializableRetry;
}
