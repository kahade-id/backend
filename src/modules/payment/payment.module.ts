import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { MidtransService } from './midtrans.service';
import { OrderQrisPaymentService } from './order-qris-payment.service';
import { WalletModule } from '../wallet/wallet.module';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';

/**
 * that was completely missing. Without MidtransService, wallet.service.ts topup()
 * created a DB record but returned no payment URL to the user.
 */
@Module({
  imports: [ConfigModule, WalletModule],
  controllers: [PaymentController],
  providers: [PaymentService, MidtransService, OrderQrisPaymentService, WalletTxSerialService],
  exports: [PaymentService, MidtransService, OrderQrisPaymentService],
})
export class PaymentModule {}
