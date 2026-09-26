import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { InsuranceController } from './insurance.controller';
import { InsuranceService } from './insurance.service';

@Module({
  imports: [PrismaModule, SubscriptionsModule],
  controllers: [InsuranceController],
  providers: [InsuranceService],
  exports: [InsuranceService],
})
export class InsuranceModule {}
