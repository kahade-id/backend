import { OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { RedisService } from '../../redis/redis.service';
export declare class SchedulerModule implements OnModuleDestroy, OnApplicationBootstrap {
    private schedulerRegistry;
    private configService;
    private redis;
    private readonly logger;
    private instrumentationTimer?;
    constructor(schedulerRegistry: SchedulerRegistry, configService: ConfigService, redis: RedisService);
    onApplicationBootstrap(): void;
    private instrumentCronJobs;
    private writeCronHeartbeat;
    onModuleDestroy(): Promise<void>;
}
