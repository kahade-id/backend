import { Module } from '@nestjs/common';
import { TransactionTemplatesController } from './transaction-templates.controller';
import { TransactionTemplatesService } from './transaction-templates.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TransactionTemplatesController],
  providers: [TransactionTemplatesService],
  exports: [TransactionTemplatesService],
})
export class TransactionTemplatesModule {}
