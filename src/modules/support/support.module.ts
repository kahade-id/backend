import { Module } from '@nestjs/common';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { UploadModule } from '../upload/upload.module';
import { AuditLogModule } from '../../common/services/audit-log.module';

@Module({
  imports: [PrismaModule, UploadModule, AuditLogModule],
  controllers: [SupportController],
  providers: [SupportService],
})
export class SupportModule {}
