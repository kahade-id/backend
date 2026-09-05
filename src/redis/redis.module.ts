import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    {
      provide: RedisService,
      useFactory: (configService: ConfigService): RedisService => {
        const redisUrl = configService.get<string>('redis.url') ?? 'redis://localhost:6379';
        const prefix = configService.get<string>('redis.prefix') ?? 'kahade:';
        return new RedisService(redisUrl, prefix);
      },
      inject: [ConfigService],
    },
  ],
  exports: [RedisService],
})
export class RedisModule {}
