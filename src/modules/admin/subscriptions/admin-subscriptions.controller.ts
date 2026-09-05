import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Post, Param, Query, UseGuards, Req } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminSubscriptionsService } from './admin-subscriptions.service';
import { SubscriptionListQueryDto } from './dto/subscription-list-query.dto';
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
    return this.service.listSubscriptions(query.page!, query.limit!, query.status, query.plan);
  }

  @Get(':subId')
  @ApiOperation({ summary: 'Get subscription detail' })
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
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ message: string; subscriptionId: string; status: string }> {
    return this.service.forceCancelSubscription(subId, adminId, req.ip ?? '');
  }
}
