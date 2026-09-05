import { Controller, Get, Post, Body, Query, HttpCode, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ReferralCode, ReferralRelation } from '@prisma/client';
import { ReferralService } from './referral.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AllowResponseFields } from '../../common/decorators/allow-response-fields.decorator';
import { ApplyReferralDto } from './dto/apply-referral.dto';
import { PaginationDto, PaginatedResponse } from '../../common/dto/pagination.dto';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';

@ApiTags('referral')
@ApiBearerAuth('access-token')
@Controller('referral')
export class ReferralController {
  constructor(private referralService: ReferralService) {}

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('my-code')
  @AllowResponseFields('code')
  async getMyCode(@CurrentUser('sub') userId: string): Promise<ReferralCode> {
    return this.referralService.getOrCreateCode(userId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 3600000, limit: 10 } })
  @Post('apply')
  async applyCode(
    @CurrentUser('sub') userId: string,
    @Body() dto: ApplyReferralDto,
  ): Promise<ReferralRelation> {
    return this.referralService.applyCode(userId, dto.code);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('stats')
  @AllowResponseFields('code')
  async getStats(@CurrentUser('sub') userId: string): Promise<Record<string, unknown>> {
    return this.referralService.getStats(userId);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('rewards')
  async getRewards(
    @CurrentUser('sub') userId: string,
    @Query() query: PaginationDto,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.referralService.getRewards(userId, query.page ?? 1, query.limit ?? 20);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 3600000, limit: 3 } })
  @Post('regenerate')
  @HttpCode(200)
  @AllowResponseFields('code')
  async regenerateCode(@CurrentUser('sub') userId: string): Promise<ReferralCode> {
    return this.referralService.regenerateCode(userId);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('history')
  async getHistory(
    @CurrentUser('sub') userId: string,
    @Query() query: PaginationDto,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.referralService.getHistory(userId, query.page ?? 1, query.limit ?? 20);
  }
}
