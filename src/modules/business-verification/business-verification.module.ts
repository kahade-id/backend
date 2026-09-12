import { Module } from '@nestjs/common';
import { BusinessVerificationController } from './business-verification.controller';
import { BusinessVerificationService } from './business-verification.service';
import { AuditLogModule } from '../../common/services/audit-log.module';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { UploadModule } from '../upload/upload.module';
import { VerificationBadgeModule } from '../users/verification-badge.module';

@Module({
  imports: [AuditLogModule, UploadModule, VerificationBadgeModule],
  controllers: [BusinessVerificationController],
  providers: [BusinessVerificationService, WalletTxSerialService],
  exports: [BusinessVerificationService],
})
export class BusinessVerificationModule {}
