import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { AdminFinanceController } from './admin-finance.controller';
import { AdminFinanceService } from './admin-finance.service';
import { AdminDisbursementController } from './admin-disbursement.controller';
import { AdminDisbursementService } from './admin-disbursement.service';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationFindingsService } from './reconciliation-findings.service';
import { LedgerCorrectionService } from './ledger-corrections.service';
import { ReconciliationProcessor, RECONCILIATION_QUEUE } from './reconciliation.processor';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { RedisModule } from '../../../redis/redis.module';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { PaymentModule } from '../../../modules/payment/payment.module';
import { DanaModule } from '../../../modules/payment/dana/dana.module';
import { WalletModeModule } from '../../../modules/wallet-mode/wallet-mode.module';
import { DashboardModule } from '../dashboard/dashboard.module';

@Module({
  imports: [
    PrismaModule,
    AuditLogModule,
    RedisModule,
    PaymentModule,
    DanaModule, // BAI-043: AdminDisbursementService butuh DanaDisbursementService (recheck status DANA)
    WalletModeModule, // BAI-041/054: WalletKillSwitchGuard + WalletModeService (kill-switch era tanpa-wallet)
    DashboardModule, // AW-018: invalidasi cache summary dashboard
    BullModule.registerQueue({
      name: RECONCILIATION_QUEUE,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 20,
        removeOnFail: 10,
      },
    }),
  ],
  controllers: [AdminFinanceController, AdminDisbursementController],
  providers: [
    AdminFinanceService,
    AdminDisbursementService,
    ReconciliationService,
    ReconciliationFindingsService,
    LedgerCorrectionService,
    WalletTxSerialService,
    ReconciliationProcessor,
  ],
  exports: [ReconciliationService],
})
export class AdminFinanceModule {}
