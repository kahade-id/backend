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
import { AdminManagementController } from './admin-management.controller';
import { CreateEmergencyGrantDto } from './dto/emergency-grant.dto';
import { CreateHandoffDto, HandoffQueryDto } from './dto/create-handoff.dto';

/**
 * GAP-E5 (G384–G386): alias route literal `/v1/admin/...` untuk kontrak
 * yang dipakai admin web (src/lib/api/admin/management.ts).
 *
 * Route asli tetap hidup di `/v1/admin/management/...`; controller ini
 * hanya mendelegasikan ke AdminManagementController agar logika tidak
 * terduplikasi. Semua guard/decorator direplikasi 1:1 (SUPER_ADMIN,
 * throttle, idempotency) karena decorator pada controller target TIDAK
 * ikut dieksekusi saat method dipanggil langsung.
 */
@ApiTags('admin-ops')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN')
@AdminRoute()
@Controller('admin')
export class AdminOpsAliasController {
  constructor(private readonly management: AdminManagementController) {}

  @Get('emergency-grants')
  @ApiOperation({ summary: 'Daftar grant akses darurat (kontrak admin web)' })
  @ApiResponse({ status: 200, description: 'Emergency grants returned.' })
  listEmergencyGrantsWeb(@Query('activeOnly') activeOnly?: string): Promise<object> {
    return this.management.listEmergencyGrantsWeb(activeOnly);
  }

  @Get('emergency-grants/active')
  @ApiOperation({ summary: 'Daftar grant akses darurat yang aktif' })
  @ApiResponse({ status: 200, description: 'Active emergency grants returned.' })
  listActiveEmergencyGrants(): Promise<object> {
    return this.management.listEmergencyGrants();
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
    return this.management.createEmergencyGrant(dto, adminId, admin, req);
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
    return this.management.revokeEmergencyGrantWeb(grantId, adminId, req);
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
    return this.management.revokeEmergencyGrant(grantId, adminId, req);
  }

  @Get('access-review')
  @ApiOperation({ summary: 'Review akses periodik (kontrak admin web)' })
  @ApiResponse({ status: 200, description: 'Access review list returned.' })
  accessReview(): Promise<object> {
    return this.management.accessReview();
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
    return this.management.certifyAccessReview(targetId, adminId, req);
  }

  @Get('handoffs/workload')
  @ApiOperation({ summary: 'Beban kasus per petugas (kontrak admin web)' })
  @ApiResponse({ status: 200, description: 'Workload returned.' })
  handoffWorkload(): Promise<object> {
    return this.management.handoffWorkload();
  }

  @Get('handoffs')
  @ApiOperation({ summary: 'Riwayat handoff satu kasus (kontrak admin web)' })
  @ApiResponse({ status: 200, description: 'Handoff history returned.' })
  listHandoffs(@Query() query: HandoffQueryDto): Promise<object> {
    return this.management.listHandoffs(query);
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
    return this.management.createHandoff(dto, adminId, req);
  }
}
