import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';
export declare const ADMIN_JWT_SERVICE = "ADMIN_JWT_SERVICE";
export declare class JwtAuthGuard implements CanActivate {
    private reflector;
    private jwtService;
    private redisService;
    private configService;
    private prismaService;
    private readonly logger;
    private localCircuitFailureCount;
    private localCircuitLastFailure;
    private adminJwtService;
    constructor(reflector: Reflector, jwtService: JwtService, adminJwtService: JwtService | null, redisService: RedisService, configService: ConfigService, prismaService: PrismaService);
    private isCircuitOpen;
    private recordRedisFailure;
    private recordRedisSuccess;
    canActivate(context: ExecutionContext): Promise<boolean>;
    private isFailOpenEnabled;
    private checkBlacklist;
    private checkDatabaseAuthorization;
    private extractTokenFromHeader;
    private extractTokenFromCookie;
}
