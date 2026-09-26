import { Controller, Get, Post, Body, Query, Param, Req, UseGuards, DefaultValuePipe, ParseIntPipe } from '@nestjs/common';
import { ClampLimitPipe } from '../../common/pipes/clamp-limit.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
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
import { SubscribeDto, RenewDto, PauseSubscriptionDto } from './dto/subscribe.dto';

@ApiTags('subscriptions')
@ApiBearerAuth('access-token')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private subscriptionsService: SubscriptionsService) {}

  @Get('me')
  @ApiOperation({ summary: 'Ringkasan status Kahade+ milik user (spek Kahade+)' })
  async getMe(@CurrentUser('sub') userId: string): Promise<Record<string, unknown>> {
    return this.subscriptionsService.getMe(userId);
  }

  @Get('status')
  async getStatus(@CurrentUser('sub') userId: string): Promise<Record<string, unknown>> {
    return this.subscriptionsService.getStatus(userId);
  }

  @Post('subscribe')
  @ApiOperation({ summary: 'Start Kahade Plus subscription, with optional promo code (free grant or discount). Tidak butuh KYC.' })
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  async subscribe(
    @CurrentUser('sub') userId: string,
    @Body() dto: SubscribeDto,
    @Req() req: Request,
  ): Promise<Subscription> {
    return this.subscriptionsService.subscribe(userId, dto.plan, dto.pin, req.ip, {
      promoCode: dto.promoCode,
    });
  }

  @Post('subscribe-qris')
  @ApiOperation({ summary: 'Start Kahade Plus subscription via QRIS (Flash Mobile). Returns qrString to render. PIN required.' })
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  async subscribeQris(
    @CurrentUser('sub') userId: string,
    @Body() dto: SubscribeDto,
    @Req() req: Request,
  ): Promise<{ subscriptionId: string; subscription: Subscription; qrString: string; expiredAt: Date; flashTransactionId: string }> {
    const result = await this.subscriptionsService.subscribeQris(userId, dto.plan, dto.pin ?? '', req.ip, dto.promoCode);
    return { subscriptionId: result.subscription.id, ...result };
  }

  @Get('qris-status/:id')
  @ApiOperation({ summary: 'Poll QRIS subscription payment status (PENDING/ACTIVE)' })
  async getQrisStatus(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ): Promise<{ status: string; qrString: string | null; expiredAt: Date | null }> {
    return this.subscriptionsService.getQrisStatus(userId, id);
  }

  @Post('pause')
  @ApiOperation({ summary: 'Pause active Kahade Plus subscription, optionally until resumeAt' })
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  async pause(
    @CurrentUser('sub') userId: string,
    @Body() dto: PauseSubscriptionDto,
  ): Promise<Subscription> {
    return this.subscriptionsService.pause(userId, dto.resumeAt ? new Date(dto.resumeAt) : undefined);
  }

  @Post('resume')
  @ApiOperation({ summary: 'Resume a paused Kahade Plus subscription' })
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  async resume(@CurrentUser('sub') userId: string): Promise<Subscription> {
    return this.subscriptionsService.resume(userId);
  }

  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @Idempotency()
  @UseGuards(UserThrottleGuard)
  @Post('cancel')
  @ApiOperation({ summary: 'Cancel at period end — benefit tetap aktif sampai currentPeriodEnd' })
  async cancel(@CurrentUser('sub') userId: string): Promise<Subscription> {
    return this.subscriptionsService.cancel(userId);
  }

  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @Idempotency()
  @UseGuards(UserThrottleGuard)
  @Post('reactivate')
  @ApiOperation({ summary: 'Batalkan pembatalan — lanjutkan langganan sebelum periode berakhir' })
  async reactivate(@CurrentUser('sub') userId: string): Promise<Subscription> {
    return this.subscriptionsService.reactivate(userId);
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

  @Post('upgrade')
  @ApiOperation({ summary: 'Upgrade subscription with proration (11.1)' })
  @UseGuards(KycRequiredGuard, UserThrottleGuard)
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  async upgrade(
    @CurrentUser('sub') userId: string,
    @Body() dto: { newPlan: any; pin: string },
    @Req() req: Request,
  ): Promise<object> {
    return this.subscriptionsService.upgradeSubscription(userId, dto.newPlan, dto.pin, req.ip);
  }
}
