import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { ChartQueryDto } from './dto/chart-query.dto';

@ApiTags('admin-dashboard')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN')
@AdminRoute()
@Controller('admin/dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Get dashboard summary', description: 'Returns aggregated stats: user counts, active/completed orders, open disputes, pending KYC, and total wallet balance.' })
  @ApiResponse({ status: 200, description: 'Dashboard summary returned.' })
  @ApiResponse({ status: 401, description: 'Invalid or expired admin token.' })
  getSummary(): Promise<object> {
    return this.service.getSummary();
  }

  @Get('charts')
  @ApiOperation({ summary: 'Get chart data', description: 'Returns time-series data for orders and revenue over the specified period.' })
  @ApiResponse({ status: 200, description: 'Chart data returned.' })
  getCharts(@Query() query: ChartQueryDto): Promise<object> {
    return this.service.getCharts(query);
  }

  @Get('recent-activity')
  @ApiOperation({ summary: 'Get recent admin activity', description: 'Returns the most recent admin audit log entries.' })
  @ApiResponse({ status: 200, description: 'Recent activity returned.' })
  getRecentActivity(): Promise<{ data: object[] }> {
    return this.service.getRecentActivity();
  }

  @Get('user-growth')
  @ApiOperation({ summary: 'Get user growth stats', description: 'Returns user registration statistics over the specified period.' })
  @ApiResponse({ status: 200, description: 'User growth data returned.' })
  getUserGrowth(@Query() query: ChartQueryDto): Promise<object> {
    return this.service.getUserGrowth(query);
  }

  @Get('order-stats')
  @ApiOperation({ summary: 'Get order status distribution', description: 'Returns order counts grouped by status.' })
  @ApiResponse({ status: 200, description: 'Order stats returned.' })
  getOrderStats(): Promise<object> {
    return this.service.getOrderStats();
  }
}
