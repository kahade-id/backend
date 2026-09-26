import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import { Controller, Get, Post, Param, Body, Query, UseGuards, Req } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { AdminShowcaseReportsService } from './admin-showcase-reports.service';
import { ShowcaseReportListQueryDto } from './dto/showcase-report-list-query.dto';
import { ReviewShowcaseReportDto } from './dto/review-showcase-report.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRole } from '@prisma/client';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

@ApiTags('admin-showcase-reports')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.CUSTOMER_SUPPORT)
@AdminRoute()
@Controller('admin/showcase-reports')
export class AdminShowcaseReportsController {
  constructor(private readonly service: AdminShowcaseReportsService) {}

  @Get()
  @ApiOperation({
    summary: 'List showcase reports',
    description: 'Paginated moderation queue of user-submitted showcase (etalase) reports, with optional status filter.',
  })
  @ApiResponse({ status: 200, description: 'Showcase reports list returned.' })
  @ApiResponse({ status: 400, description: 'Invalid status filter.' })
  listShowcaseReports(@Query() query: ShowcaseReportListQueryDto): Promise<object> {
    return this.service.listShowcaseReports(query.page!, query.limit!, query.status);
  }

  @Get(':reportId')
  @ApiOperation({
    summary: 'Get showcase report detail',
    description: 'Returns full report detail including the reported showcase item, its images, owner, and reporter.',
  })
  @ApiResponse({ status: 200, description: 'Showcase report detail returned.' })
  @ApiResponse({ status: 404, description: 'Showcase report not found.' })
  getShowcaseReportDetail(@Param('reportId', ParseIdPipe) reportId: string): Promise<object> {
    return this.service.getShowcaseReportDetail(reportId);
  }

  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Post(':reportId/review')
  @ApiOperation({
    summary: 'Review a showcase report',
    description:
      'Moderate a showcase report. Actions: dismiss (→ DISMISSED), takedown (deactivate the item and → RESOLVED_ACTION_TAKEN), no_action (→ RESOLVED_NO_ACTION), under_review (→ UNDER_REVIEW). Final statuses cannot be re-processed. Requires Idempotency-Key.',
  })
  @ApiResponse({ status: 200, description: 'Showcase report reviewed.' })
  @ApiResponse({ status: 400, description: 'Report already resolved/dismissed, or item already inactive.' })
  @ApiResponse({ status: 404, description: 'Showcase report not found.' })
  reviewShowcaseReport(
    @Param('reportId', ParseIdPipe) reportId: string,
    @Body() dto: ReviewShowcaseReportDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.reviewShowcaseReport(reportId, dto.action, dto.resolution, admin.sub, req.ip ?? '');
  }
}
