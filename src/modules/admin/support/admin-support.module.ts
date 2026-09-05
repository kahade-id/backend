import { Module } from '@nestjs/common';
import { AdminSupportController } from './admin-support.controller';
import { AdminSupportService } from './admin-support.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [AdminSupportController],
  providers: [AdminSupportService],
})
export class AdminSupportModule {}
