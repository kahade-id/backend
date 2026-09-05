import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { RedisModule } from '../../redis/redis.module';
import { RealtimeGateway } from './realtime.gateway';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeService } from './realtime.service';

@Global()
@Module({
  imports: [JwtModule.register({}), RedisModule, ConfigModule, NotificationsModule],
  providers: [RealtimeGateway, RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
