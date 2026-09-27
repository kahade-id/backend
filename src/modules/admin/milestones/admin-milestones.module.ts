// GAP-C (G196–G199): modul admin milestone.
// INTEGRATION-FIX: PrismaService tidak didaftarkan di sini — PrismaModule
// @Global() (path benar: src/prisma/prisma.service).
import { Module } from '@nestjs/common';
import { AdminMilestonesController } from './admin-milestones.controller';
import { AdminMilestonesService } from './admin-milestones.service';
import { MilestonesModule } from '../../milestones/milestones.module';

@Module({
  imports: [MilestonesModule],
  controllers: [AdminMilestonesController],
  providers: [AdminMilestonesService],
})
export class AdminMilestonesModule {}
