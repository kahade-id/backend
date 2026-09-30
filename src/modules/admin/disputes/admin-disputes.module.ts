import { Module } from '@nestjs/common';
import { AdminDisputesController } from './admin-disputes.controller';
import { AdminDisputesService } from './admin-disputes.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { UploadModule } from '../../upload/upload.module';
import { ChatModule } from '../../chat/chat.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { NoWalletModule } from '../../no-wallet/no-wallet.module';
import { WalletModeModule } from '../../wallet-mode/wallet-mode.module';

@Module({
  imports: [AuditLogModule, UploadModule, ChatModule, DashboardModule, NoWalletModule, WalletModeModule],
  controllers: [AdminDisputesController],
  providers: [AdminDisputesService, WalletTxSerialService],
  exports: [AdminDisputesService],
})
export class AdminDisputesModule {}
