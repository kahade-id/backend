import { Module } from '@nestjs/common';
import { AdminSubscriptionsController } from './admin-subscriptions.controller';
import { AdminSubscriptionsService } from './admin-subscriptions.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { PaymentModule } from '../../payment/payment.module';

@Module({
  imports: [AuditLogModule, PaymentModule],
  controllers: [AdminSubscriptionsController],
  providers: [AdminSubscriptionsService],
})
export class AdminSubscriptionsModule {}
