import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { AdminFinanceController } from './admin-finance.controller';
import { AdminFinanceService } from './admin-finance.service';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationProcessor, RECONCILIATION_QUEUE } from './reconciliation.processor';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { PaymentModule } from '../../../modules/payment/payment.module';

@Module({
  imports: [
    PrismaModule,
    AuditLogModule,
    PaymentModule,
    BullModule.registerQueue({
      name: RECONCILIATION_QUEUE,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 20,
        removeOnFail: 10,
      },
    }),
  ],
  controllers: [AdminFinanceController],
  providers: [AdminFinanceService, ReconciliationService, ReconciliationProcessor],
  exports: [ReconciliationService],
})
export class AdminFinanceModule {}
