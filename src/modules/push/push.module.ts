import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PushService } from './push.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
