import { Injectable, BadRequestException } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import * as crypto from 'crypto';
import * as ErrorCodes from '../../common/constants/error-codes';

const CAPTCHA_PREFIX = 'captcha:';
const CAPTCHA_TTL = 120;
const CAPTCHA_MIN_SOLVE_MS = 800;
const CAPTCHA_MAX_SOLVE_MS = 120_000;
// B-04 (audit-fix): tighten the slider tolerance from 8 percentage-points to 4.
// targetX is expressed in *percent* (the mobile/admin clients render it as
// `${targetX}%`), so the 60-pp target range previously gave an attacker a
// ~1-in-(60/16)=27% accidental-match probability; with a 4-pp tolerance that
// drops to ~13%. Combined with the per-attempt rate-limit on the consuming
// endpoint, this raises brute-force cost above the rate-limit threshold.
// Keep the [20, 80] target range -- changing it would break the percentage
// math in the frontend slider component.
const POSITION_TOLERANCE = 4;
const TARGET_X_MIN = 20;
const TARGET_X_RANGE = 60;

export interface CaptchaChallenge {
  challengeId: string;
  targetX: number;
  issuedAt: number;
}

@Injectable()
export class CaptchaService {
  constructor(private readonly redis: RedisService) {}

  async generateChallenge(): Promise<{ challengeId: string; targetX: number }> {
    const challengeId = crypto.randomUUID();
    // CSPRNG to avoid predictable captcha targets (SEC: replaces Math.random()).
    const targetX = TARGET_X_MIN + crypto.randomInt(0, TARGET_X_RANGE);
    const issuedAt = Date.now();

    await this.redis.set(
      `${CAPTCHA_PREFIX}${challengeId}`,
      JSON.stringify({ targetX, issuedAt }),
      CAPTCHA_TTL,
      { throwOnError: true },
    );

    return { challengeId, targetX };
  }

  async verifyChallenge(challengeId: string, answerX: number): Promise<void> {
    if (!challengeId || typeof answerX !== 'number') {
      throw new BadRequestException({ code: ErrorCodes.CAPTCHA_FAILED, message: 'Invalid captcha response' });
    }

    const key = `${CAPTCHA_PREFIX}${challengeId}`;
    const raw = await this.redis.get(key, { throwOnError: true });

    if (!raw) {
      throw new BadRequestException({ code: ErrorCodes.CAPTCHA_EXPIRED, message: 'Captcha expired or already used. Please try again.' });
    }

    await this.redis.del(key, { throwOnError: true });

    let data: { targetX: number; issuedAt: number };
    try {
      data = JSON.parse(raw);
    } catch {
      throw new BadRequestException({ code: ErrorCodes.CAPTCHA_FAILED, message: 'Invalid captcha data' });
    }

    const elapsed = Date.now() - data.issuedAt;
    if (elapsed < CAPTCHA_MIN_SOLVE_MS) {
      throw new BadRequestException({ code: ErrorCodes.CAPTCHA_FAILED, message: 'Captcha solved too quickly' });
    }
    if (elapsed > CAPTCHA_MAX_SOLVE_MS) {
      throw new BadRequestException({ code: ErrorCodes.CAPTCHA_EXPIRED, message: 'Captcha expired. Please try again.' });
    }

    const diff = Math.abs(data.targetX - answerX);
    if (diff > POSITION_TOLERANCE) {
      throw new BadRequestException({ code: ErrorCodes.CAPTCHA_FAILED, message: 'Captcha verification failed. Please try again.' });
    }
  }
}
