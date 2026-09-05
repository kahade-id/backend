import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VouchersController } from './vouchers.controller';
import { VouchersService } from './vouchers.service';
import { FeeCalculatorService } from '../orders/fee-calculator.service';

@Module({
  imports: [ConfigModule],
  controllers: [VouchersController],
  providers: [VouchersService, FeeCalculatorService],
  exports: [VouchersService],
})
export class VouchersModule {}
