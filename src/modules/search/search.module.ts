import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { VerificationBadgeModule } from '../users/verification-badge.module';

@Module({
  imports: [PrismaModule, VerificationBadgeModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
