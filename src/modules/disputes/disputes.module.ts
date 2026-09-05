import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisModule } from '../../redis/redis.module';
import { UploadModule } from '../upload/upload.module';
import { OrdersModule } from '../orders/orders.module';
import { DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';
import { DisputeMessageService } from './dispute-message.service';
import { DisputeCallService } from './dispute-call.service';
import { MutualResolutionService } from './mutual-resolution.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { AuditLogModule } from '../../common/services/audit-log.module';

@Module({
  imports: [PrismaModule, RedisModule, UploadModule, AuditLogModule, forwardRef(() => OrdersModule)],
  controllers: [DisputesController],
  providers: [DisputesService, DisputeMessageService, DisputeCallService, MutualResolutionService, WalletTxSerialService],
  exports: [DisputesService],
})
export class DisputesModule {}
