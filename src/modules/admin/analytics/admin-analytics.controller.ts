import { Controller, Get, Query, DefaultValuePipe, ParseIntPipe, BadRequestException, UseGuards, Logger, Req } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AdminAnalyticsService } from '../admin-analytics.service';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRoute } from '../../../common/decorators/public.decorator';
import { ParseDateQueryPipe, ParseEnumQueryPipe } from '../../../common/pipes/parse-query-string.pipe';
import { ClampLimitPipe } from '../../../common/pipes/clamp-limit.pipe';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { Request } from 'express';

function parseOptionalDate(value: string | undefined, field: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new BadRequestException(`${field} is not a valid date`);
  }
  return date;
}

@ApiTags('admin/analytics')
@ApiBearerAuth('admin-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN')
@AdminRoute()
@Controller('admin/analytics')
export class AdminAnalyticsController {
  private readonly logger = new Logger(AdminAnalyticsController.name);

  constructor(private analyticsService: AdminAnalyticsService) {}

  private logAdminAccess(adminId: string, endpoint: string, params: Record<string, unknown>, req: Request): void {
    this.logger.log(
      JSON.stringify({
        event: 'ADMIN_READ_ACCESS',
        adminId,
        endpoint,
        params,
        ip: req.ip,
        requestId: (req as Request & { requestId?: string }).requestId ?? req.headers['x-request-id'] ?? '-',
      }),
    );
  }

  @Get('overview')
  @ApiOperation({ summary: 'Get platform overview stats' })
  async getOverview(
    @Query('startDate', new ParseDateQueryPipe('startDate')) startDate?: string,
    @Query('endDate', new ParseDateQueryPipe('endDate')) endDate?: string,
    @CurrentAdmin('sub') adminId?: string,
    @Req() req?: Request,
  ): Promise<object> {
    this.logAdminAccess(adminId ?? 'unknown', 'analytics/overview', { startDate, endDate }, req!);
    return this.analyticsService.getOverview(
      parseOptionalDate(startDate, 'startDate'),
      parseOptionalDate(endDate, 'endDate'),
    );
  }

  @Get('orders')
  @ApiOperation({ summary: 'Get order statistics over time' })
  async getOrderStats(
    @Query('groupBy', new DefaultValuePipe('day'), new ParseEnumQueryPipe('groupBy', ['day', 'week', 'month'])) groupBy: string,
    @Query('startDate', new ParseDateQueryPipe('startDate')) startDate?: string,
    @Query('endDate', new ParseDateQueryPipe('endDate')) endDate?: string,
    @CurrentAdmin('sub') adminId?: string,
    @Req() req?: Request,
  ): Promise<object[]> {
    this.logAdminAccess(adminId ?? 'unknown', 'analytics/orders', { groupBy, startDate, endDate }, req!);
    return this.analyticsService.getOrderStats(
      parseOptionalDate(startDate, 'startDate'),
      parseOptionalDate(endDate, 'endDate'),
      groupBy as 'day' | 'week' | 'month',
    );
  }

  @Get('top-users')
  @ApiOperation({ summary: 'Get top users by metric' })
  async getTopUsers(
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe, new ClampLimitPipe(100)) limit: number,
    @Query('metric', new DefaultValuePipe('orders'), new ParseEnumQueryPipe('metric', ['orders', 'volume', 'rating'])) metric: string,
    @CurrentAdmin('sub') adminId?: string,
    @Req() req?: Request,
  ): Promise<object[]> {
    this.logAdminAccess(adminId ?? 'unknown', 'analytics/top-users', { limit, metric }, req!);
    return this.analyticsService.getTopUsers(limit, metric as 'orders' | 'volume' | 'rating');
  }

  @Get('user-growth')
  @ApiOperation({ summary: 'Get user growth over time' })
  async getUserGrowth(
    @Query('startDate', new ParseDateQueryPipe('startDate')) startDate?: string,
    @Query('endDate', new ParseDateQueryPipe('endDate')) endDate?: string,
    @CurrentAdmin('sub') adminId?: string,
    @Req() req?: Request,
  ): Promise<object[]> {
    this.logAdminAccess(adminId ?? 'unknown', 'analytics/user-growth', { startDate, endDate }, req!);
    return this.analyticsService.getUserGrowth(
      parseOptionalDate(startDate, 'startDate'),
      parseOptionalDate(endDate, 'endDate'),
    );
  }
}
