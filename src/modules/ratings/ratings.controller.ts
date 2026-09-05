import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { Rating } from '@prisma/client';
import { RatingsService } from './ratings.service';
import { RatingReplyService } from './rating-reply.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateRatingDto } from './dto/create-rating.dto';
import { UpdateRatingDto } from './dto/update-rating.dto';
import { PaginationDto, PaginatedResponse } from '../../common/dto/pagination.dto';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { Idempotency } from '../../common/decorators/idempotency.decorator';

export class RatingReplyDto {
  // Without @ApiProperty this DTO serialised to `properties: {}` in openapi.json, leaving the
  // reply body undocumented for both clients. The sibling rating DTOs already declare it
  // (`create-rating.dto.ts:16`).
  @ApiProperty({ description: 'Reply content', maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  // C-11: must match `RatingReply.content @db.VarChar(500)` (`schema.prisma`). At 2000 a
  // 501-2000 char reply passed validation and then failed in Postgres with 22001, surfacing
  // as an opaque 500. The sibling rating DTOs already pin 500 (`create-rating.dto.ts:19`).
  @MaxLength(500)
  content!: string;
}

@ApiTags('ratings')
@ApiBearerAuth('access-token')
@Controller('ratings')
export class RatingsController {
  constructor(
    private ratingsService: RatingsService,
    private ratingReplyService: RatingReplyService,
  ) {}

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Idempotency()
  @Post()
  async createRating(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateRatingDto,
  ): Promise<Rating> {
    return this.ratingsService.createRating(userId, dto);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('my')
  async getMyRatings(
    @CurrentUser('sub') userId: string,
    @Query() pagination: PaginationDto,
  ): Promise<{ given: PaginatedResponse<Record<string, unknown>>; received: PaginatedResponse<Record<string, unknown>> }> {
    return this.ratingsService.getMyRatings(userId, pagination.page ?? 1, pagination.limit ?? 20);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Idempotency()
  @Put(':ratingId')
  async updateRating(
    @CurrentUser('sub') userId: string,
    @Param('ratingId', ParseIdPipe) ratingId: string,
    @Body() dto: UpdateRatingDto,
  ): Promise<Rating> {
    return this.ratingsService.updateRating(userId, ratingId, dto);
  }

  @UseGuards(UserThrottleGuard)
  @Post(':ratingId/reply')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Idempotency()
  @ApiOperation({ summary: 'Reply to a rating' })
  async replyToRating(
    @CurrentUser('sub') userId: string,
    @Param('ratingId', ParseIdPipe) ratingId: string,
    @Body() dto: RatingReplyDto,
  ): Promise<object> {
    return this.ratingReplyService.createReply(userId, ratingId, dto.content);
  }

  @UseGuards(UserThrottleGuard)
  @Put('replies/:replyId')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Idempotency()
  @ApiOperation({ summary: 'Update a reply' })
  async updateReply(
    @CurrentUser('sub') userId: string,
    @Param('replyId', ParseIdPipe) replyId: string,
    @Body() dto: RatingReplyDto,
  ): Promise<object> {
    return this.ratingReplyService.updateReply(userId, replyId, dto.content);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Idempotency()
  @Delete('replies/:replyId')
  @ApiOperation({ summary: 'Delete a reply' })
  async deleteReply(
    @CurrentUser('sub') userId: string,
    @Param('replyId', ParseIdPipe) replyId: string,
  ): Promise<{ message: string }> {
    return this.ratingReplyService.deleteReply(userId, replyId);
  }
}
