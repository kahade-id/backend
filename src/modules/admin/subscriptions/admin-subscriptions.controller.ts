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
import { StepUpGuard } from '../../../common/guards/step-up.guard';
import { RequireStepUp } from '../../../common/decorators/require-step-up.decorator';

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
  @UseGuards(UserThrottleGuard, StepUpGuard)
  // SYS-B-402: grant = pemberian nilai uang (langganan gratis).
  @RequireStepUp('subscription.grant')
  @ApiOperation({ summary: 'Grant a subscription manually (ACTIVE, tanpa pembayaran)', description: 'SYS-B-402: requires X-Step-Up-Token (action subscription.grant). Nilai di atas Rp1.000.000 wajib dual control (actionType MONEY_VALUE_GRANT).' })
  @ApiResponse({ status: 201, description: 'Subscription granted.' })
  grantSubscription(
    @Body() dto: GrantSubscriptionDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.grantSubscription(dto.userId, dto.plan, dto.durationDays, dto.reason, adminId, req.ip ?? '');
  }

  // ---------- Kode promo gratis (keputusan produk 2026-09-26) ----------
  // NOTE: @Get('promo-codes') HARUS dideklarasikan SEBELUM @Get(':subId') —
  // kalau tidak, request ke /promo-codes jatuh ke :subId dan gagal ParseIdPipe (400).

  @Post('promo-codes')
  @UseGuards(UserThrottleGuard, StepUpGuard)
  // SYS-B-402: kode promo = penciptaan liabilitas (durasi gratis × batas pakai).
  @RequireStepUp('subscription.promoCode.create')
  @ApiOperation({ summary: 'Buat kode promo langganan gratis (durasi & batas pakai diatur admin)', description: 'SYS-B-402: requires X-Step-Up-Token (action subscription.promoCode.create). Nilai di atas Rp1.000.000 wajib dual control (actionType MONEY_VALUE_GRANT).' })
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
  @UseGuards(UserThrottleGuard, StepUpGuard)
  // SYS-B-402: menonaktifkan kode promo mengubah liabilitas aktif.
  @RequireStepUp('subscription.promoCode.toggle', 'id')
  @ApiOperation({ summary: 'Nonaktifkan kode promo', description: 'SYS-B-402: requires X-Step-Up-Token (action subscription.promoCode.toggle).' })
  disablePromoCode(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.setPromoCodeStatus(id, false, adminId, req.ip ?? '');
  }

  @Post('promo-codes/:id/enable')
  @UseGuards(UserThrottleGuard, StepUpGuard)
  // SYS-B-402: mengaktifkan kembali kode promo menghidupkan liabilitas.
  @RequireStepUp('subscription.promoCode.toggle', 'id')
  @ApiOperation({ summary: 'Aktifkan kembali kode promo', description: 'SYS-B-402: requires X-Step-Up-Token (action subscription.promoCode.toggle).' })
  enablePromoCode(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.setPromoCodeStatus(id, true, adminId, req.ip ?? '');
  }

  @Get(':subId')
  @ApiOperation({ summary: 'Get subscription detail + usage periode berjalan' })
  @ApiResponse({ status: 200, description: 'Subscription detail returned.' })
  @ApiResponse({ status: 404, description: 'Subscription not found.' })
  getSubscriptionDetail(@Param('subId', ParseIdPipe) subId: string): Promise<object> {
    return this.service.getSubscriptionDetail(subId);
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
