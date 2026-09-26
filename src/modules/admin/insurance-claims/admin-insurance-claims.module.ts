import { Module } from '@nestjs/common';
import { AdminInsuranceClaimsController } from './admin-insurance-claims.controller';
import { AdminInsuranceClaimsService } from './admin-insurance-claims.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';

@Module({
  imports: [AuditLogModule],
  controllers: [AdminInsuranceClaimsController],
  // Batch 1-money (INS-001): payout klaim butuh serial ledger WLT-*.
  providers: [AdminInsuranceClaimsService, WalletTxSerialService],
})
export class AdminInsuranceClaimsModule {}
