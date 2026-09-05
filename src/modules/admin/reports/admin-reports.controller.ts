import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Post, Param, Body, Query, UseGuards, Req } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminReportsService } from './admin-reports.service';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRole } from '@prisma/client';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { ReportQueryDto } from './dto/report-query.dto';
import { ResolveReportDto } from './dto/resolve-report.dto';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { Request } from 'express';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';

@ApiTags('admin-reports')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.CUSTOMER_SUPPORT)
@AdminRoute()
@Controller('admin/reports')
export class AdminReportsController {
  constructor(private readonly service: AdminReportsService) {}

  @Get()
  @ApiOperation({ summary: 'List all user reports', description: 'Paginated list of user reports with optional status and category filters.' })
  @ApiResponse({ status: 200, description: 'Reports list returned.' })
  listReports(@Query() query: ReportQueryDto): Promise<object> {
    return this.service.listReports(
      query.page ?? 1,
      query.limit ?? 20,
      query.status,
      query.category,
    );
  }

  @Get(':reportId')
  @ApiOperation({ summary: 'Get report detail', description: 'Returns full report detail including reporter and target user info.' })
  @ApiResponse({ status: 200, description: 'Report detail returned.' })
  @ApiResponse({ status: 404, description: 'Report not found.' })
  getReportDetail(@Param('reportId', ParseIdPipe) reportId: string): Promise<object> {
    return this.service.getReportDetail(reportId);
  }

  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Post(':reportId/resolve')
  @ApiOperation({ summary: 'Resolve report', description: 'Resolve a user report with action taken.' })
  @ApiResponse({ status: 200, description: 'Report resolved.' })
  @ApiResponse({ status: 404, description: 'Report not found.' })
  @ApiResponse({ status: 400, description: 'Report already resolved or dismissed.' })
  resolveReport(
    @Param('reportId', ParseIdPipe) reportId: string,
    @Body() dto: ResolveReportDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<{ message: string; reportId: string }> {
    return this.service.resolveReport(reportId, dto.resolution, admin.sub, req.ip ?? '', dto.resolveStatus);
  }

  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Post(':reportId/dismiss')
  @ApiOperation({ summary: 'Dismiss report', description: 'Dismiss a user report without action.' })
  @ApiResponse({ status: 200, description: 'Report dismissed.' })
  @ApiResponse({ status: 404, description: 'Report not found.' })
  @ApiResponse({ status: 400, description: 'Report already resolved or dismissed.' })
  dismissReport(
    @Param('reportId', ParseIdPipe) reportId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<{ message: string; reportId: string }> {
    return this.service.dismissReport(reportId, admin.sub, req.ip ?? '');
  }
}
