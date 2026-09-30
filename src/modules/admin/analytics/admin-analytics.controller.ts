import { Controller, Get, Query, DefaultValuePipe, ParseIntPipe, BadRequestException, UseGuards, Logger, Req, Res } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AdminAnalyticsService } from '../admin-analytics.service';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRoute } from '../../../common/decorators/public.decorator';
import { ParseDateQueryPipe, ParseEnumQueryPipe } from '../../../common/pipes/parse-query-string.pipe';
import { ClampLimitPipe } from '../../../common/pipes/clamp-limit.pipe';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { withCsvExportWatermark } from '../../../common/utils/csv-watermark.util';
import { parseDateBoundaryWIB } from '../../../common/utils/date.util';
import { Request, Response } from 'express';

/**
 * BAI-128: tanggal kalender "YYYY-MM-DD" diparse sebagai BATAS HARI WIB
 * (start = 00:00:00 WIB, end = 23:59:59.999 WIB) — konsisten dengan
 * dashboard (parseDateBoundaryWIB). Sebelumnya `new Date(value)` = 00:00 UTC
 * (= 07:00 WIB) sehingga 7 jam pertama hari WIB dan ±17 jam terakhir hari
 * akhir rentang tidak terhitung di Analitik. Nilai ISO penuh non-kalender
 * (mis. "2026-01-01T10:30:00Z") tetap dipakai apa adanya.
 */
function parseOptionalDate(
  value: string | undefined,
  field: string,
  boundary: 'start' | 'end',
): Date | undefined {
  if (!value) return undefined;
  const date = parseDateBoundaryWIB(value, boundary);
  if (!date || isNaN(date.getTime())) {
    throw new BadRequestException(`${field} is not a valid date`);
  }
  return date;
}

@ApiTags('admin/analytics')
@ApiBearerAuth('admin-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN', 'FINANCE_ADMIN')
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
  @ApiOperation({
    summary: 'Get platform overview stats',
    description: 'BAI-128: startDate/endDate "YYYY-MM-DD" = batas hari WIB penuh ' +
      '(00:00:00–23:59:59.999 Asia/Jakarta), konsisten dengan dashboard charts. ' +
      'BAI-134: disputeRate = disputed ÷ (completed + disputed) × 100 (order ' +
      'CANCELLED tidak masuk denominator), dalam persen 0–100. ' +
      'activeUsers = pengguna unik yang jadi buyer/seller order dalam rentang ' +
      '(bukan DAU/MAU).',
  })
  async getOverview(
    @Query('startDate', new ParseDateQueryPipe('startDate')) startDate?: string,
    @Query('endDate', new ParseDateQueryPipe('endDate')) endDate?: string,
    @CurrentAdmin('sub') adminId?: string,
    @Req() req?: Request,
  ): Promise<object> {
    this.logAdminAccess(adminId ?? 'unknown', 'analytics/overview', { startDate, endDate }, req!);
    return this.analyticsService.getOverview(
      parseOptionalDate(startDate, 'startDate', 'start'),
      parseOptionalDate(endDate, 'endDate', 'end'),
    );
  }

  @Get('orders')
  @ApiOperation({
    summary: 'Get order statistics over time',
    description: 'BAI-128: startDate/endDate "YYYY-MM-DD" = batas hari WIB penuh ' +
      '(Asia/Jakarta). BAI-129: `period` diserialisasi sebagai tanggal WIB ' +
      '"YYYY-MM-DD" (bukan timestamp — abaikan jam bila ada konsumen lama ' +
      'yang masih membaca timestamp).',
  })
  async getOrderStats(
    @Query('groupBy', new DefaultValuePipe('day'), new ParseEnumQueryPipe('groupBy', ['day', 'week', 'month'])) groupBy: string,
    @Query('startDate', new ParseDateQueryPipe('startDate')) startDate?: string,
    @Query('endDate', new ParseDateQueryPipe('endDate')) endDate?: string,
    @CurrentAdmin('sub') adminId?: string,
    @Req() req?: Request,
  ): Promise<object[]> {
    this.logAdminAccess(adminId ?? 'unknown', 'analytics/orders', { groupBy, startDate, endDate }, req!);
    return this.analyticsService.getOrderStats(
      parseOptionalDate(startDate, 'startDate', 'start'),
      parseOptionalDate(endDate, 'endDate', 'end'),
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
  @ApiOperation({
    summary: 'Get user growth over time',
    description: 'BAI-128: startDate/endDate "YYYY-MM-DD" = batas hari WIB penuh ' +
      '(Asia/Jakarta). BAI-129: `day` diserialisasi sebagai tanggal WIB "YYYY-MM-DD".',
  })
  async getUserGrowth(
    @Query('startDate', new ParseDateQueryPipe('startDate')) startDate?: string,
    @Query('endDate', new ParseDateQueryPipe('endDate')) endDate?: string,
    @CurrentAdmin('sub') adminId?: string,
    @Req() req?: Request,
  ): Promise<object[]> {
    this.logAdminAccess(adminId ?? 'unknown', 'analytics/user-growth', { startDate, endDate }, req!);
    return this.analyticsService.getUserGrowth(
      parseOptionalDate(startDate, 'startDate', 'start'),
      parseOptionalDate(endDate, 'endDate', 'end'),
    );
  }

  @Get('export/csv')
  @ApiOperation({ summary: 'Export analytics overview CSV (19.4)' })
  async exportCsv(
    @Res() res: Response,
    @Query('startDate', new ParseDateQueryPipe('startDate')) startDate?: string,
    @Query('endDate', new ParseDateQueryPipe('endDate')) endDate?: string,
    @CurrentAdmin('sub') adminId?: string,
    @Req() req?: Request,
  ): Promise<void> {
    this.logAdminAccess(adminId ?? 'unknown', 'analytics/export/csv', { startDate, endDate }, req!);
    const overview = await this.analyticsService.getOverview(
      parseOptionalDate(startDate, 'startDate', 'start'),
      parseOptionalDate(endDate, 'endDate', 'end'),
    ) as any;
    const csvHeader = 'metric,value\n';
    const csvRows = Object.entries(overview).map(([k, v]) => `${k},${typeof v === 'object' ? JSON.stringify(v).replace(/,/g, ';') : v}`).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=\"analytics-export.csv\"');
    // ADM-429: watermark pengekspor di baris awal CSV untuk keterlacakan kebocoran.
    res.send(withCsvExportWatermark(csvHeader + csvRows, adminId ?? 'unknown', 'admin/analytics/export'));
  }
}
