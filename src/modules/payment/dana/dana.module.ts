import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DanaPaymentService } from './dana-payment.service';
import { DanaDisbursementService } from './dana-disbursement.service';

/**
 * DANA Enterprise (Gapura) — provider pembayaran UTAMA Kahade.
 *
 * - DanaPaymentService: Create Order QRIS/VA/Balance, Query, Refund, Cancel
 * - DanaDisbursementService: Transfer ke bank, transfer ke akun DANA,
 *   bank account inquiry, DANA account inquiry, inquiry status transfer
 */
@Module({
  imports: [ConfigModule],
  providers: [DanaPaymentService, DanaDisbursementService],
  exports: [DanaPaymentService, DanaDisbursementService],
})
export class DanaModule {}
