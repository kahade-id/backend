import { Module } from '@nestjs/common';
import { RatingsController } from './ratings.controller';
import { RatingsService } from './ratings.service';
import { RatingReplyService } from './rating-reply.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [RatingsController],
  providers: [RatingsService, RatingReplyService],
  exports: [RatingsService, RatingReplyService],
})
export class RatingsModule {}
