import { RedisService } from '../../redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';
export declare class WalletTxSerialService {
    private redis;
    private prisma;
    private static readonly TTL_2_DAYS;
    private readonly logger;
    private static readonly LUA_ATOMIC_INCR;
    private static readonly LUA_SET_IF_GREATER;
    constructor(redis: RedisService, prisma: PrismaService);
    getNext(): Promise<number>;
    private atomicIncr;
    getNextForPrefix(prefix: string): Promise<number>;
    private syncFromDb;
}
