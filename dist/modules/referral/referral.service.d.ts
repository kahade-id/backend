import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { Prisma, ReferralCode, ReferralRelation } from '@prisma/client';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { PaginatedResponse } from '../../common/dto/pagination.dto';
export declare class ReferralService {
    private prisma;
    private redis;
    private walletTxSerialService;
    private configService;
    private readonly logger;
    constructor(prisma: PrismaService, redis: RedisService, walletTxSerialService: WalletTxSerialService, configService: ConfigService);
    getOrCreateCode(userId: string): Promise<ReferralCode>;
    applyCode(userId: string, code: string): Promise<ReferralRelation>;
    getStats(userId: string): Promise<Record<string, unknown>>;
    getRewards(userId: string, page: number, limit: number): Promise<PaginatedResponse<Record<string, unknown>>>;
    regenerateCode(userId: string): Promise<ReferralCode>;
    getHistory(userId: string, page: number, limit: number): Promise<PaginatedResponse<Record<string, unknown>>>;
    createReferralRewardIfEligible(userId: string, feeAmount: bigint, orderId: string, tx: Prisma.TransactionClient): Promise<void>;
    private creditReward;
}
