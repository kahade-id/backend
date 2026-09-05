import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
export declare class FraudChallengeEscalationService {
    private prisma;
    private redis;
    private readonly logger;
    private static readonly ESCALATION_THRESHOLD_HOURS;
    constructor(prisma: PrismaService, redis: RedisService);
    escalateStaleChallenges(): Promise<void>;
}
