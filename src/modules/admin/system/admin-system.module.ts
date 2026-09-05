import { Module } from '@nestjs/common';
import { AdminSystemController } from './admin-system.controller';
import { AdminSystemService } from './admin-system.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { QueueModule } from '../../queue/queue.module';

@Module({
  imports: [PrismaModule, AuditLogModule, QueueModule],
  controllers: [AdminSystemController],
  providers: [AdminSystemService],
})
export class AdminSystemModule {}
