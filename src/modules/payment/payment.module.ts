import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { MidtransService } from './midtrans.service';
import { FlashQrisService } from './flash-qris.service';
import { OrderQrisPaymentService } from './order-qris-payment.service';
import { DanaModule } from './dana/dana.module';
import { WalletModule } from '../wallet/wallet.module';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';

/**
 * that was completely missing. Without MidtransService, wallet.service.ts topup()
 * created a DB record but returned no payment URL to the user.
 */
@Module({
  imports: [ConfigModule, WalletModule, DanaModule],
  controllers: [PaymentController],
  providers: [PaymentService, MidtransService, FlashQrisService, OrderQrisPaymentService, WalletTxSerialService],
  exports: [PaymentService, MidtransService, FlashQrisService, OrderQrisPaymentService, DanaModule],
})
export class PaymentModule {}
