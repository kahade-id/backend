import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Param, Query, UseGuards, Req, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { AdminManagementService } from './admin-management.service';

/**
 * GAP-E (G399, kontrak admin web) — jejak aktivitas admin.
 * - GET /v1/admin/activity-log — filter adminId, action, from, to
 * - GET /v1/admin/activity-log/export — CSV (tanpa PII sensitif)
 * - GET /v1/admin/activity-log/retention — kebijakan retensi
 */
@ApiTags('admin-activity-log')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN')
@AdminRoute()
@Controller('admin/activity-log')
export class AdminActivityLogController {
  constructor(private readonly service: AdminManagementService) {}

  @Get()
  @ApiOperation({ summary: 'Jejak aktivitas admin (filter admin/aksi/rentang waktu)' })
  @ApiQuery({ name: 'adminId', required: false })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiResponse({ status: 200, description: 'Admin activity log returned.' })
  listActivity(
    @Query() pagination: PaginationDto,
    @Query('adminId') adminId?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<object> {
    return this.service.listAdminActivity({
      adminId: adminId?.trim() || undefined,
      action: action?.trim() || undefined,
      from: from?.trim() || undefined,
      to: to?.trim() || undefined,
      page: pagination.page ?? 1,
      limit: pagination.limit ?? 20,
    });
  }

  @Get('export')
  @ApiOperation({ summary: 'Ekspor CSV jejak aktivitas admin (diaudit)' })
  @ApiResponse({ status: 200, description: 'CSV file returned.' })
  async exportActivity(
    @Query('adminId') adminId: string | undefined,
    @Query('action') action: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.service.exportAdminActivityCsv(
      {
        adminId: adminId?.trim() || undefined,
        action: action?.trim() || undefined,
        from: from?.trim() || undefined,
        to: to?.trim() || undefined,
      },
      admin.sub,
      req.ip || 'unknown',
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="admin-activity-log.csv"');
    res.send(csv);
  }

  @Get('retention')
  @ApiOperation({ summary: 'Kebijakan retensi log aktivitas admin' })
  @ApiResponse({ status: 200, description: 'Retention policy returned.' })
  retention(): Promise<object> {
    return this.service.getActivityRetention();
  }
}
