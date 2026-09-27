import { Module } from '@nestjs/common';
import { AdminActionLocationsController } from './admin-action-locations.controller';
import { AdminActionLocationsService } from './admin-action-locations.service';

@Module({
  controllers: [AdminActionLocationsController],
  providers: [AdminActionLocationsService],
  exports: [AdminActionLocationsService],
})
export class AdminActionLocationsModule {}
