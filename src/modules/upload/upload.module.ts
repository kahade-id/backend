import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisModule } from '../../redis/redis.module';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { LocalStorageService } from './local-storage.service';
import { PhoneVerifiedGuard } from '../../common/guards/phone-verified.guard';

@Module({
  imports: [ConfigModule, PrismaModule, RedisModule],
  controllers: [UploadController],
  providers: [UploadService, LocalStorageService, PhoneVerifiedGuard],
  exports: [UploadService, LocalStorageService],
})
export class UploadModule {}
