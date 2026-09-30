import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisModule } from '../../redis/redis.module';
import { UploadModule } from '../upload/upload.module';
import { OrdersModule } from '../orders/orders.module';
import { DisputesController } from './disputes.controller';
import { DisputeQuickEscalationController } from './dispute-quick-escalation.controller';
import { DisputesService } from './disputes.service';
import { DisputeQuickEscalationService } from './dispute-quick-escalation.service';
import { DisputeMessageService } from './dispute-message.service';
import { DisputeCallService } from './dispute-call.service';
import { MutualResolutionService } from './mutual-resolution.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { AuditLogModule } from '../../common/services/audit-log.module';
import { NoWalletModule } from '../no-wallet/no-wallet.module';
import { WalletModeModule } from '../wallet-mode/wallet-mode.module';

@Module({
  imports: [PrismaModule, RedisModule, UploadModule, AuditLogModule, forwardRef(() => OrdersModule), NoWalletModule, WalletModeModule],
  controllers: [DisputesController, DisputeQuickEscalationController],
  providers: [DisputesService, DisputeQuickEscalationService, DisputeMessageService, DisputeCallService, MutualResolutionService, WalletTxSerialService],
  exports: [DisputesService],
})
export class DisputesModule {}
