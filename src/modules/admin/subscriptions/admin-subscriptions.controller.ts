import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Post, Param, Query, Body, UseGuards, Req } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminSubscriptionsService } from './admin-subscriptions.service';
import { SubscriptionListQueryDto } from './dto/subscription-list-query.dto';
import { GrantSubscriptionDto, CancelSubscriptionDto } from './dto/grant-subscription.dto';
import { CreatePromoCodeDto } from './dto/create-promo-code.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { Request } from 'express';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

@ApiTags('admin-subscriptions')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN', 'FINANCE_ADMIN')
@AdminRoute()
@Controller('admin/subscriptions')
export class AdminSubscriptionsController {
  constructor(private readonly service: AdminSubscriptionsService) {}

  @Get()
  @ApiOperation({ summary: 'List all subscriptions' })
  @ApiResponse({ status: 200, description: 'Subscriptions list returned.' })
  listSubscriptions(@Query() query: SubscriptionListQueryDto): Promise<object> {
    return this.service.listSubscriptions(query.page!, query.limit!, query.status, query.plan, query.search);
  }

  @Post('grant')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Grant a subscription manually (ACTIVE, tanpa pembayaran)' })
  @ApiResponse({ status: 201, description: 'Subscription granted.' })
  grantSubscription(
    @Body() dto: GrantSubscriptionDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.grantSubscription(dto.userId, dto.plan, dto.durationDays, dto.reason, adminId, req.ip ?? '');
  }

  @Get(':subId')
  @ApiOperation({ summary: 'Get subscription detail + usage periode berjalan' })
  @ApiResponse({ status: 200, description: 'Subscription detail returned.' })
  @ApiResponse({ status: 404, description: 'Subscription not found.' })
  getSubscriptionDetail(@Param('subId', ParseIdPipe) subId: string): Promise<object> {
    return this.service.getSubscriptionDetail(subId);
  }

  // ---------- Kode promo gratis (keputusan produk 2026-09-26) ----------

  @Post('promo-codes')
  @ApiOperation({ summary: 'Buat kode promo langganan gratis (durasi & batas pakai diatur admin)' })
  @ApiResponse({ status: 201, description: 'Promo code created.' })
  createPromoCode(
    @Body() dto: CreatePromoCodeDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.createPromoCode(
      {
        code: dto.code,
        durationDays: dto.durationDays,
        maxRedemptions: dto.maxRedemptions,
        assignedUserId: dto.assignedUserId,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        note: dto.note,
      },
      adminId,
      req.ip ?? '',
    );
  }

  @Get('promo-codes')
  @ApiOperation({ summary: 'Daftar kode promo langganan gratis' })
  listPromoCodes(@Query('page') page?: string, @Query('limit') limit?: string): Promise<object> {
    return this.service.listPromoCodes(Number(page) || 1, Math.min(Number(limit) || 20, 100));
  }

  @Post('promo-codes/:id/disable')
  @ApiOperation({ summary: 'Nonaktifkan kode promo' })
  disablePromoCode(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.setPromoCodeStatus(id, false, adminId, req.ip ?? '');
  }

  @Post('promo-codes/:id/enable')
  @ApiOperation({ summary: 'Aktifkan kembali kode promo' })
  enablePromoCode(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.setPromoCodeStatus(id, true, adminId, req.ip ?? '');
  }

  @Post(':subId/cancel')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Force cancel subscription' })
  @ApiResponse({ status: 200, description: 'Subscription cancelled.' })
  @ApiResponse({ status: 404, description: 'Subscription not found.' })
  forceCancelSubscription(
    @Param('subId', ParseIdPipe) subId: string,
    @Body() dto: CancelSubscriptionDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ message: string; subscriptionId: string; status: string }> {
    return this.service.forceCancelSubscription(subId, adminId, req.ip ?? '', dto.reason);
  }
}
