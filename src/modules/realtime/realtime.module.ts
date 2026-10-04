import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { RedisModule } from '../../redis/redis.module';
import { RealtimeGateway } from './realtime.gateway';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeService } from './realtime.service';
// POIN 5: gateway memakai SupportChatService untuk handler support.*.
import { SupportModule } from '../support/support.module';

@Global()
@Module({
  imports: [JwtModule.register({}), RedisModule, ConfigModule, NotificationsModule, SupportModule],
  providers: [RealtimeGateway, RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
