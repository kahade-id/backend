import { Module } from '@nestjs/common';
import { ConfigApiController, AppApiController } from './config-api.controller';
import { PublicModule } from '../public/public.module';

@Module({
  imports: [PublicModule],
  controllers: [ConfigApiController, AppApiController],
})
export class ConfigApiModule {}
