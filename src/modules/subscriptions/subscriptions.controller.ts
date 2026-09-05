import { Controller, Get, Post, Body, Query, Req, UseGuards, DefaultValuePipe, ParseIntPipe } from '@nestjs/common';
import { ClampLimitPipe } from '../../common/pipes/clamp-limit.pipe';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Subscription } from '@prisma/client';
import { SubscriptionsService } from './subscriptions.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Idempotency } from '../../common/decorators/idempotency.decorator';
import { KycRequiredGuard } from '../../common/guards/kyc-required.guard';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { PaginatedResponse } from '../../common/dto/pagination.dto';
import { SubscribeDto, RenewDto } from './dto/subscribe.dto';

@ApiTags('subscriptions')
@ApiBearerAuth('access-token')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private subscriptionsService: SubscriptionsService) {}

  @Get('status')
  async getStatus(@CurrentUser('sub') userId: string): Promise<Record<string, unknown>> {
    return this.subscriptionsService.getStatus(userId);
  }

  @Post('subscribe')
  @UseGuards(KycRequiredGuard, UserThrottleGuard)
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  async subscribe(
    @CurrentUser('sub') userId: string,
    @Body() dto: SubscribeDto,
    @Req() req: Request,
  ): Promise<Subscription> {
    return this.subscriptionsService.subscribe(userId, dto.plan, dto.pin, req.ip);
  }

  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @Idempotency()
  @UseGuards(UserThrottleGuard)
  @Post('cancel')
  async cancel(@CurrentUser('sub') userId: string): Promise<Subscription> {
    return this.subscriptionsService.cancel(userId);
  }

  @Get('history')
  async getHistory(
    @CurrentUser('sub') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.subscriptionsService.getHistory(userId, page, limit);
  }

  @Get('benefits')
  async getBenefits(@CurrentUser('sub') userId: string): Promise<Record<string, unknown>> {
    return this.subscriptionsService.getBenefits(userId);
  }

  @Post('renew')
  @UseGuards(KycRequiredGuard, UserThrottleGuard)
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  async renew(
    @CurrentUser('sub') userId: string,
    @Body() dto: RenewDto,
    @Req() req: Request,
  ): Promise<Subscription> {
    return this.subscriptionsService.renew(userId, dto.pin, req.ip);
  }

  @Public()
  @Get('plans')
  async getPlans(): Promise<Array<{ plan: string; label: string; price: number; durationDays: number; feeSavingsLimit: number }>> {
    return this.subscriptionsService.getPlans();
  }
}
