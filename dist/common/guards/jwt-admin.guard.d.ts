import { CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';
export declare class JwtAdminGuard implements CanActivate {
    private jwtService;
    private redisService;
    private configService;
    private prisma;
    private readonly logger;
    constructor(jwtService: JwtService, redisService: RedisService, configService: ConfigService, prisma: PrismaService);
    canActivate(context: ExecutionContext): Promise<boolean>;
    private getAllowedPathsForScope;
    private extractTokenFromHeader;
}
