import { HealthCheckResult, HealthCheckService, PrismaHealthIndicator, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import type { Request } from 'express';
import { Queue } from 'bull';
declare class RedisHealthIndicator extends HealthIndicator {
    private redis;
    constructor(redis: RedisService);
    isHealthy(key: string): Promise<HealthIndicatorResult>;
}
declare class DiskHealthIndicator extends HealthIndicator {
    isHealthy(key: string): Promise<HealthIndicatorResult>;
}
declare class CronHealthIndicator extends HealthIndicator {
    private redis;
    private static readonly CRITICAL_CRONS;
    constructor(redis: RedisService);
    isHealthy(key: string): Promise<HealthIndicatorResult>;
}
declare class MidtransHealthIndicator extends HealthIndicator {
    private config;
    constructor(config: ConfigService);
    isHealthy(key: string): Promise<HealthIndicatorResult>;
}
declare class R2HealthIndicator extends HealthIndicator {
    private config;
    private readonly logger;
    constructor(config: ConfigService);
    isHealthy(key: string): Promise<HealthIndicatorResult>;
}
declare class SmtpHealthIndicator extends HealthIndicator {
    private config;
    private readonly logger;
    constructor(config: ConfigService);
    isHealthy(key: string): Promise<HealthIndicatorResult>;
}
declare class WebhookInboxHealthIndicator extends HealthIndicator {
    private prisma;
    private redis;
    constructor(prisma: PrismaService, redis: RedisService);
    isHealthy(key: string): Promise<HealthIndicatorResult>;
}
export declare class HealthController {
    private health;
    private prismaIndicator;
    private redisIndicator;
    private diskIndicator;
    private cronIndicator;
    private midtransIndicator;
    private r2Indicator;
    private smtpIndicator;
    private webhookInboxIndicator;
    private prisma;
    private config;
    private redis;
    private readonly emailQueue?;
    private readonly notificationQueue?;
    private readonly auditLogQueue?;
    private readonly deadLetterQueue?;
    private readonly logger;
    constructor(health: HealthCheckService, prismaIndicator: PrismaHealthIndicator, redisIndicator: RedisHealthIndicator, diskIndicator: DiskHealthIndicator, cronIndicator: CronHealthIndicator, midtransIndicator: MidtransHealthIndicator, r2Indicator: R2HealthIndicator, smtpIndicator: SmtpHealthIndicator, webhookInboxIndicator: WebhookInboxHealthIndicator, prisma: PrismaService, config: ConfigService, redis: RedisService, emailQueue?: Queue | undefined, notificationQueue?: Queue | undefined, auditLogQueue?: Queue | undefined, deadLetterQueue?: Queue | undefined);
    check(): Promise<any>;
    internalReady(request: Request): Promise<{
        status: 'ready';
    }>;
    private queueIndicator;
    private healthIndicatorStatus;
    checkWebhooks(): Promise<HealthCheckResult>;
    checkCrons(): Promise<HealthCheckResult>;
}
export declare class HealthModule {
}
export {};
