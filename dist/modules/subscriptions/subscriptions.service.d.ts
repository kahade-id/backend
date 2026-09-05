import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { Subscription, SubscriptionPlan } from '@prisma/client';
import { PaginatedResponse } from '../../common/dto/pagination.dto';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditLogService } from '../../common/services/audit-log.service';
export declare class SubscriptionsService {
    private prisma;
    private walletTxSerialService;
    private walletService;
    private configService;
    private redis;
    private auditLogService;
    private readonly logger;
    private readonly planPricing;
    constructor(prisma: PrismaService, walletTxSerialService: WalletTxSerialService, walletService: WalletService, configService: ConfigService, redis: RedisService, auditLogService: AuditLogService);
    getStatus(userId: string): Promise<Record<string, unknown>>;
    subscribe(userId: string, plan: SubscriptionPlan, pin: string, ip?: string): Promise<Subscription>;
    cancel(userId: string): Promise<Subscription>;
    getHistory(userId: string, page: number, limit: number): Promise<PaginatedResponse<Record<string, unknown>>>;
    getBenefits(userId: string): Promise<Record<string, unknown>>;
    renew(userId: string, pin: string, ip?: string): Promise<Subscription>;
    getPlans(): Promise<Array<{
        plan: string;
        label: string;
        price: number;
        durationDays: number;
        feeSavingsLimit: number;
    }>>;
}
