import { Module } from '@nestjs/common';
import { AdminDisputesController } from './admin-disputes.controller';
import { AdminDisputesService } from './admin-disputes.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { UploadModule } from '../../upload/upload.module';

@Module({
  imports: [AuditLogModule, UploadModule],
  controllers: [AdminDisputesController],
  providers: [AdminDisputesService, WalletTxSerialService],
  exports: [AdminDisputesService],
})
export class AdminDisputesModule {}
