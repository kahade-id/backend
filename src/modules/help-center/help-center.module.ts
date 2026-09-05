import { Module } from '@nestjs/common';
import { HelpCenterController } from './help-center.controller';
import { HelpCenterService } from './help-center.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [HelpCenterController],
  providers: [HelpCenterService],
  exports: [HelpCenterService],
})
export class HelpCenterModule {}
