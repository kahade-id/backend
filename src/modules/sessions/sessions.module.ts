import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { RedisModule } from '../../redis/redis.module';

@Module({
  imports: [RedisModule, ConfigModule],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
