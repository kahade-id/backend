import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { MidtransService } from '../../payment/midtrans.service';
import { WalletService } from '../../wallet/wallet.service';
export declare class PendingTopupCleanupService {
    private prisma;
    private redis;
    private configService;
    private midtransService;
    private walletService;
    private readonly logger;
    private readonly topupExpiryHours;
    constructor(prisma: PrismaService, redis: RedisService, configService: ConfigService, midtransService: MidtransService, walletService: WalletService);
    cleanupStaleTopups(): Promise<void>;
}
