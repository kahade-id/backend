import { Module } from '@nestjs/common';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';
import { AuditLogModule } from '../../common/services/audit-log.module';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { UploadModule } from '../upload/upload.module';

@Module({
  imports: [AuditLogModule, UploadModule],
  controllers: [KycController],
  providers: [KycService, WalletTxSerialService],
  exports: [KycService],
})
export class KycModule {}
