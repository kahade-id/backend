import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BankAccountsController } from './bank-accounts.controller';
import { BankAccountsService } from './bank-accounts.service';
import { PaymentModule } from '../payment/payment.module';
import { AuditLogModule } from '../../common/services/audit-log.module';
import { PhoneVerifiedGuard } from '../../common/guards/phone-verified.guard';

@Module({
  imports: [ConfigModule, PaymentModule, AuditLogModule],
  controllers: [BankAccountsController],
  providers: [BankAccountsService, PhoneVerifiedGuard],
  exports: [BankAccountsService],
})
export class BankAccountsModule {}
