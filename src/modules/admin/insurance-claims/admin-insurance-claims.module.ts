import { Module } from '@nestjs/common';
import { AdminInsuranceClaimsController } from './admin-insurance-claims.controller';
import { AdminInsuranceClaimsService } from './admin-insurance-claims.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [AdminInsuranceClaimsController],
  providers: [AdminInsuranceClaimsService],
})
export class AdminInsuranceClaimsModule {}
