import { RedisService } from '../../redis/redis.service';
export interface CaptchaChallenge {
    challengeId: string;
    targetX: number;
    issuedAt: number;
}
export declare class CaptchaService {
    private readonly redis;
    constructor(redis: RedisService);
    generateChallenge(): Promise<{
        challengeId: string;
        targetX: number;
    }>;
    verifyChallenge(challengeId: string, answerX: number): Promise<void>;
}
