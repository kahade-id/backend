import { Module } from '@nestjs/common';
import { AdminVouchersController } from './admin-vouchers.controller';
import { AdminVouchersService } from './admin-vouchers.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [AdminVouchersController],
  providers: [AdminVouchersService],
})
export class AdminVouchersModule {}
