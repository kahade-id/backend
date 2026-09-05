import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
export declare class SubscriptionExpiryService {
    private prisma;
    private redis;
    private walletTxSerialService;
    private configService;
    private readonly logger;
    private readonly planPricing;
    constructor(prisma: PrismaService, redis: RedisService, walletTxSerialService: WalletTxSerialService, configService: ConfigService);
    handleExpiredSubscriptions(): Promise<void>;
    private tryAutoRenew;
    private processExpiredSubscriptions;
    private processGracePeriodExpired;
    private sendExpiryReminders;
}
