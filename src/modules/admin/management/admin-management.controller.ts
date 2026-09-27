import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Post, Put, Patch, Delete, Param, Body, Query, UseGuards, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ParseQueryStringPipe } from '../../../common/pipes/parse-query-string.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { AdminManagementService } from './admin-management.service';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { SuspendAdminDto } from './dto/suspend-admin.dto';
import { ChangeAdminRoleDto } from './dto/change-admin-role.dto';
import { CreateEmergencyGrantDto } from './dto/emergency-grant.dto';
import { CreateHandoffDto, HandoffQueryDto } from './dto/create-handoff.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { Request } from 'express';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';

@ApiTags('admin-management')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN')
@AdminRoute()
@Controller('admin/management')
export class AdminManagementController {
  constructor(private readonly service: AdminManagementService) {}

  @Get()
  @ApiOperation({ summary: 'List all admin users' })
  @ApiQuery({ name: 'search', required: false, description: 'Search by name, email, or adminId' })
  @ApiResponse({ status: 200, description: 'Admin list returned.' })
  listAdmins(
    @Query() pagination: PaginationDto,
    @Query('search', new ParseQueryStringPipe('search', 100)) search?: string,
  ): Promise<object> {
    return this.service.listAdmins(pagination.page!, pagination.limit!, search);
  }

  // ── GAP-E (G376–G400): rute literal didefinisikan SEBELUM ':id' agar tidak
  // tertelan Param(':id') oleh Express (emergency-grants / access-review
  // adalah satu segmen path, sama seperti ':id').

  @Get('emergency-grants')
  @ApiOperation({ summary: 'Daftar grant akses darurat (kontrak admin web)', description: 'Query activeOnly (default true). Hanya SUPER_ADMIN.' })
  @ApiResponse({ status: 200, description: 'Emergency grants returned.' })
  listEmergencyGrantsWeb(
    @Query('activeOnly') activeOnly?: string,
  ): Promise<object> {
    return this.service.listEmergencyGrants(activeOnly !== 'false' && activeOnly !== '0');
  }

  @Delete('emergency-grants/:id')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Cabut grant akses darurat (kontrak admin web)', description: 'Hanya SUPER_ADMIN. Audit EMERGENCY_ACCESS_REVOKED.' })
  @ApiResponse({ status: 200, description: 'Emergency grant revoked.' })
  @ApiResponse({ status: 404, description: 'Grant not found.' })
  revokeEmergencyGrantWeb(
    @Param('id', ParseIdPipe) grantId: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.revokeEmergencyGrant(grantId, adminId, req.ip ?? '');
  }

  @Get('emergency-grants/active')
  @ApiOperation({ summary: 'Daftar grant akses darurat yang aktif', description: 'Hanya SUPER_ADMIN.' })
  @ApiResponse({ status: 200, description: 'Active emergency grants returned.' })
  listEmergencyGrants(): Promise<object> {
    return this.service.listActiveEmergencyGrants();
  }

  @Post('emergency-grants')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({
    summary: 'Grant akses darurat berjangka',
    description: 'Hanya SUPER_ADMIN. Kedaluwarsa maks 120 menit. Audit EMERGENCY_ACCESS_GRANTED.',
  })
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

  @Post('emergency-grants/:grantId/revoke')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cabut grant akses darurat', description: 'Hanya SUPER_ADMIN. Audit EMERGENCY_ACCESS_REVOKED.' })
  @ApiResponse({ status: 200, description: 'Emergency grant revoked.' })
  @ApiResponse({ status: 404, description: 'Grant not found.' })
  revokeEmergencyGrant(
    @Param('grantId', ParseIdPipe) grantId: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.revokeEmergencyGrant(grantId, adminId, req.ip ?? '');
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

  @Get('access-review')
  @ApiOperation({
    summary: 'Review akses periodik',
    description: 'Daftar admin + tanggal sertifikasi ulang akses terakhir (dari ADMIN_ROLE_CHANGED / penandaan review / createdAt). Siklus 90 hari.',
  })
  @ApiResponse({ status: 200, description: 'Access review list returned.' })
  accessReview(): Promise<object> {
    return this.service.accessReview();
  }

  @Get('handoffs/workload')
  @ApiOperation({ summary: 'Beban kasus per petugas', description: 'Handoff diterima 30 hari terakhir + dispute aktif yang di-assign.' })
  @ApiResponse({ status: 200, description: 'Workload returned.' })
  handoffWorkload(): Promise<object> {
    return this.service.handoffWorkload();
  }

  @Post('handoffs')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Catat handoff kasus antar petugas', description: 'Audit CASE_HANDOFF_CREATED.' })
  @ApiResponse({ status: 201, description: 'Handoff created.' })
  @ApiResponse({ status: 400, description: 'Invalid input (mis. from = to, admin tidak aktif).' })
  createHandoff(
    @Body() dto: CreateHandoffDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.createHandoff(dto, adminId, req.ip ?? '');
  }

  @Get('handoffs')
  @ApiOperation({ summary: 'Riwayat handoff satu kasus', description: 'Query: caseType=kyc|dispute|report, caseId.' })
  @ApiResponse({ status: 200, description: 'Handoff history returned.' })
  listHandoffs(@Query() query: HandoffQueryDto): Promise<object> {
    return this.service.listHandoffsByCase(query);
  }

  @Post(':id/review')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Tandai akses admin sudah direview', description: 'Sertifikasi ulang manual — tercatat di AdminAuditLog.' })
  @ApiResponse({ status: 200, description: 'Access marked as reviewed.' })
  @ApiResponse({ status: 404, description: 'Admin not found.' })
  markAccessReviewed(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.markAccessReviewed(id, adminId, req.ip ?? '');
  }

  @Get(':id/sessions')
  @ApiOperation({ summary: 'Daftar sesi login admin', description: 'Sesi aktif + yang baru dicabut (maks 50).' })
  @ApiResponse({ status: 200, description: 'Admin sessions returned.' })
  @ApiResponse({ status: 404, description: 'Admin not found.' })
  listAdminSessions(@Param('id', ParseIdPipe) id: string): Promise<object> {
    return this.service.listAdminSessions(id);
  }

  @Delete(':id/sessions/:sessionId')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({
    summary: 'Cabut satu sesi admin',
    description:
      'Audit ADMIN_SESSION_REVOKED. Sebagai fail-safe, seluruh token akses admin tersebut ikut dibatalkan ' +
      '(JWT stateless tidak tertaut per-sesi) sehingga admin harus login ulang.',
  })
  @ApiResponse({ status: 200, description: 'Session revoked.' })
  @ApiResponse({ status: 404, description: 'Session not found.' })
  revokeAdminSession(
    @Param('id', ParseIdPipe) id: string,
    @Param('sessionId', ParseIdPipe) sessionId: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.revokeAdminSession(id, sessionId, adminId, req.ip ?? '');
  }

  @Post(':id/suspend')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suspend akun admin',
    description: 'Alasan wajib. isActive=false + token dicabut + audit ADMIN_SUSPENDED. Riwayat dipertahankan (bisa reactivate).',
  })
  @ApiResponse({ status: 200, description: 'Admin suspended.' })
  @ApiResponse({ status: 403, description: 'Cannot suspend self / last super admin.' })
  @ApiResponse({ status: 404, description: 'Admin not found.' })
  @ApiResponse({ status: 409, description: 'Admin already suspended.' })
  suspendAdmin(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: SuspendAdminDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.suspendAdmin(id, dto, adminId, req.ip ?? '');
  }

  @Post(':id/reactivate')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aktifkan kembali akun admin yang di-suspend', description: 'Audit ADMIN_REACTIVATED.' })
  @ApiResponse({ status: 200, description: 'Admin reactivated.' })
  @ApiResponse({ status: 404, description: 'Admin not found.' })
  @ApiResponse({ status: 409, description: 'Admin already active.' })
  reactivateAdmin(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.reactivateAdmin(id, adminId, req.ip ?? '');
  }

  @Put(':id/role')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({
    summary: 'Ubah role admin (alasan wajib) — DEPRECATED',
    // ADM-022: duplikasi `PATCH :id/role` di bawah; PUT dipertahankan hanya
    // untuk kompatibilitas dan ditandai deprecated di Swagger.
    description: 'DEPRECATED: gunakan PATCH /v1/admin/management/:id/role (kontrak admin web). Audit ADMIN_ROLE_CHANGED dengan before/after. Token lama dicabut.',
    deprecated: true,
  })
  @ApiResponse({ status: 200, description: 'Role changed.' })
  @ApiResponse({ status: 400, description: 'Role unchanged.' })
  @ApiResponse({ status: 403, description: 'Cannot change own role / last super admin.' })
  @ApiResponse({ status: 404, description: 'Admin not found.' })
  changeAdminRole(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: ChangeAdminRoleDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.changeAdminRole(id, dto, adminId, req.ip ?? '');
  }

  @Get(':id/audit-log')
  @ApiOperation({ summary: 'Histori perubahan hak akun admin (kontrak admin web)' })
  @ApiResponse({ status: 200, description: 'Admin rights-change history returned.' })
  @ApiResponse({ status: 404, description: 'Admin not found.' })
  getAdminAuditLog(
    @Param('id', ParseIdPipe) id: string,
    @Query() pagination: PaginationDto,
  ): Promise<object> {
    return this.service.listAdminAuditLog(id, pagination.page ?? 1, pagination.limit ?? 20);
  }

  @Patch(':id/role')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({
    summary: 'Ubah role admin (kontrak admin web)',
    description: 'Alasan WAJIB (min 5 karakter). Tidak bisa untuk akun sendiri. Audit ADMIN_ROLE_CHANGED.',
  })
  @ApiResponse({ status: 200, description: 'Admin role changed.' })
  @ApiResponse({ status: 400, description: 'Reason required / same role.' })
  @ApiResponse({ status: 403, description: 'Cannot change own role.' })
  changeAdminRolePatch(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: ChangeAdminRoleDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.changeAdminRole(id, dto, adminId, req.ip ?? '');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get admin detail' })
  @ApiResponse({ status: 200, description: 'Admin detail returned.' })
  @ApiResponse({ status: 404, description: 'Admin not found.' })
  getAdmin(@Param('id', ParseIdPipe) id: string): Promise<object> {
    return this.service.getAdmin(id);
  }


  @Post()
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Create a new admin user' })
  @ApiResponse({ status: 201, description: 'Admin created.' })
  @ApiResponse({ status: 409, description: 'Email already exists.' })
  createAdmin(
    @Body() dto: CreateAdminDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.createAdmin(dto, adminId, req.ip ?? '');
  }

  @Put(':id')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Update admin user' })
  @ApiResponse({ status: 200, description: 'Admin updated.' })
  @ApiResponse({ status: 404, description: 'Admin not found.' })
  updateAdmin(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: UpdateAdminDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.updateAdmin(id, dto, adminId, req.ip ?? '');
  }

  @Post(':id/reset-2fa')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset admin 2FA' })
  @ApiResponse({ status: 200, description: '2FA reset successfully.' })
  @ApiResponse({ status: 404, description: 'Admin not found.' })
  resetAdmin2fa(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.resetAdmin2fa(id, adminId, req.ip ?? '');
  }

  @Post(':id/unlock')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unlock locked admin account' })
  @ApiResponse({ status: 200, description: 'Admin unlocked.' })
  @ApiResponse({ status: 404, description: 'Admin not found.' })
  unlockAdmin(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.unlockAdmin(id, adminId, req.ip ?? '');
  }

  @Delete(':id')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Soft-delete admin user' })
  @ApiResponse({ status: 200, description: 'Admin deleted.' })
  @ApiResponse({ status: 404, description: 'Admin not found.' })
  deleteAdmin(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.deleteAdmin(id, adminId, req.ip ?? '');
  }
}
