import { RedisService } from '../../redis/redis.service';
export interface CaptchaChallenge {
    challengeId: string;
    targetX: number;
    issuedAt: number;
}
export declare class CaptchaService {
    private readonly redis;
    constructor(redis: RedisService);
    shouldRequireLoginCaptcha(ipAddress: string): Promise<boolean>;
    recordLoginFailure(ipAddress: string): Promise<void>;
    clearLoginFailures(ipAddress: string): Promise<void>;
    generateChallenge(): Promise<{
        challengeId: string;
        targetX: number;
    }>;
    verifyChallenge(challengeId: string, answerX: number): Promise<void>;
}
