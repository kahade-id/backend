import { NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { RedisService } from '../../redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';
export declare class IdempotencyInterceptor implements NestInterceptor {
    private reflector;
    private redisService;
    private configService;
    private prismaService;
    private readonly logger;
    constructor(reflector: Reflector, redisService: RedisService, configService: ConfigService, prismaService: PrismaService);
    private get ttl();
    intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>>;
    private claimDurably;
    private claimWithRedis;
}
