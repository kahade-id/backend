import { AdminRoute } from '../../../common/decorators/public.decorator';
import {
  Controller, Get, Post, Delete, Param, Body, Query,
  UseGuards, Req, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import { Request } from 'express';
import { AdminManagementService } from './admin-management.service';
import { CreateEmergencyGrantDto } from './dto/emergency-grant.dto';
import { CreateHandoffDto, HandoffQueryDto } from './dto/create-handoff.dto';

/**
 * GAP-E5 (G384–G386): alias route literal `/v1/admin/...` untuk kontrak
 * yang dipakai admin web (src/lib/api/admin/management.ts).
 *
 * Route asli tetap hidup di `/v1/admin/management/...`; controller ini
 * mendelegasikan ke AdminManagementService (bukan ke controller lain —
 * controller bukan provider sehingga tidak bisa di-inject). Semua
 * guard/decorator direplikasi 1:1 (SUPER_ADMIN, throttle, idempotency).
 *
 * ADM-422: kesetaraan guard kedua controller ditegakkan oleh contract test
 * `tests/admin-ops-alias-guard-contract.spec.ts` — ubah satu sisi tanpa sisi
 * lain → test gagal.
 */
@ApiTags('admin-ops')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN')
@AdminRoute()
@Controller('admin')
export class AdminOpsAliasController {
  constructor(private readonly service: AdminManagementService) {}

  @Get('emergency-grants')
  @ApiOperation({ summary: 'Daftar grant akses darurat (kontrak admin web)' })
  @ApiResponse({ status: 200, description: 'Emergency grants returned.' })
  listEmergencyGrantsWeb(@Query('activeOnly') activeOnly?: string): Promise<object> {
    return this.service.listEmergencyGrants(activeOnly !== 'false' && activeOnly !== '0');
  }

  @Get('emergency-grants/active')
  @ApiOperation({ summary: 'Daftar grant akses darurat yang aktif' })
  @ApiResponse({ status: 200, description: 'Active emergency grants returned.' })
  listActiveEmergencyGrants(): Promise<object> {
    return this.service.listActiveEmergencyGrants();
  }

  @Post('emergency-grants')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Grant akses darurat berjangka (kontrak admin web)' })
  @ApiResponse({ status: 201, description: 'Emergency grant created.' })
  @ApiResponse({ status: 403, description: 'Requires SUPER_ADMIN.' })
  createEmergencyGrant(
    @Body() dto: CreateEmergencyGrantDto,
    @CurrentAdmin('sub') adminId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.createEmergencyGrant(dto, adminId, admin?.role ?? '', req.ip ?? '');
  }

  @Delete('emergency-grants/:id')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Cabut grant akses darurat (kontrak admin web)' })
  @ApiResponse({ status: 200, description: 'Emergency grant revoked.' })
  @ApiResponse({ status: 404, description: 'Grant not found.' })
  revokeEmergencyGrantWeb(
    @Param('id', ParseIdPipe) grantId: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.revokeEmergencyGrant(grantId, adminId, req.ip ?? '');
  }

  @Post('emergency-grants/:grantId/revoke')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cabut grant akses darurat' })
  @ApiResponse({ status: 200, description: 'Emergency grant revoked.' })
  @ApiResponse({ status: 404, description: 'Grant not found.' })
  revokeEmergencyGrant(
    @Param('grantId', ParseIdPipe) grantId: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.revokeEmergencyGrant(grantId, adminId, req.ip ?? '');
  }

  @Get('access-review')
  @ApiOperation({ summary: 'Review akses periodik (kontrak admin web)' })
  @ApiResponse({ status: 200, description: 'Access review list returned.' })
  accessReview(): Promise<object> {
    return this.service.accessReview();
  }

  @Post('access-review/:adminId/certify')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Tandai akses admin sudah direview (kontrak admin web)' })
  @ApiResponse({ status: 200, description: 'Access marked as reviewed.' })
  @ApiResponse({ status: 404, description: 'Admin not found.' })
  certifyAccessReview(
    @Param('adminId', ParseIdPipe) targetId: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.markAccessReviewed(targetId, adminId, req.ip ?? '');
  }

  @Get('handoffs/workload')
  @ApiOperation({ summary: 'Beban kasus per petugas (kontrak admin web)' })
  @ApiResponse({ status: 200, description: 'Workload returned.' })
  handoffWorkload(): Promise<object> {
    return this.service.handoffWorkload();
  }

  @Get('handoffs')
  @ApiOperation({ summary: 'Riwayat handoff satu kasus (kontrak admin web)' })
  @ApiResponse({ status: 200, description: 'Handoff history returned.' })
  listHandoffs(@Query() query: HandoffQueryDto): Promise<object> {
    return this.service.listHandoffsByCase(query);
  }

  @Post('handoffs')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Catat handoff kasus antar petugas (kontrak admin web)' })
  @ApiResponse({ status: 201, description: 'Handoff created.' })
  createHandoff(
    @Body() dto: CreateHandoffDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.createHandoff(dto, adminId, req.ip ?? '');
  }
}
