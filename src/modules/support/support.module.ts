import { Module } from '@nestjs/common';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { UploadModule } from '../upload/upload.module';
import { AuditLogModule } from '../../common/services/audit-log.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [PrismaModule, UploadModule, AuditLogModule, SubscriptionsModule],
  controllers: [SupportController],
  providers: [SupportService],
})
export class SupportModule {}
