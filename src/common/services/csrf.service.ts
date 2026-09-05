import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import * as crypto from 'crypto';

function parseJwtExpiresIn(value: string): number {
  const match = value.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 900;
  const num = parseInt(match[1], 10);
  switch (match[2]) {
    case 's': return num;
    case 'm': return num * 60;
    case 'h': return num * 3600;
    case 'd': return num * 86400;
    default: return 900;
  }
}

@Injectable()
export class CsrfService {
  private readonly ttlSeconds: number;

  constructor(
    private redis: RedisService,
    private configService: ConfigService,
  ) {
    const jwtExpiresIn = this.configService.get<string>('jwt.expiresIn') ?? '15m';
    this.ttlSeconds = parseJwtExpiresIn(jwtExpiresIn);
  }

  private getTokenKey(userId: string, jti: string, token: string): string {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    return `csrf:${userId}:${jti}:${tokenHash}`;
  }

  async generateToken(userId: string, jti: string): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex');
    const redisKey = this.getTokenKey(userId, jti, token);
    // Do not return a token that was not persisted; callers must fail closed when Redis is unavailable.
    await this.redis.setex(redisKey, this.ttlSeconds, '1', { throwOnError: true });
    return token;
  }

  private static readonly HEX_PATTERN = /^[0-9a-f]{64}$/i;

  async validateToken(userId: string, jti: string, csrfToken: string): Promise<boolean> {
    if (!csrfToken || !CsrfService.HEX_PATTERN.test(csrfToken)) {
      return false;
    }

    const redisKey = this.getTokenKey(userId, jti, csrfToken);
    // Consume atomically so two concurrent mutations cannot validate the same token.
    const storedToken = await this.redis.getAndDelete(redisKey, { throwOnError: true });
    return storedToken === '1';
  }
}
