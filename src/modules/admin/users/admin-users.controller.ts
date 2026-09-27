import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Post, Delete, Param, Body, Query, UseGuards, Req, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { AdminUsersService } from './admin-users.service';
import { UserListQueryDto } from './dto/user-list-query.dto';
import { UserExportQueryDto } from './dto/user-export-query.dto';
import { UserExportBodyDto } from './dto/user-export-body.dto';
import { ModerationEventsQueryDto } from './dto/moderation-events-query.dto';
import { UserOrderQueryDto } from './dto/user-order-query.dto';
import { BanUserDto } from './dto/ban-user.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { WalletAdjustDto } from './dto/wallet-adjust.dto';
import { DeletionLegalHoldDto } from './dto/deletion-legal-hold.dto';
import { GrayRevokeDto } from './dto/gray-revoke.dto';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

@ApiTags('admin-users')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN', 'CUSTOMER_SUPPORT')
@AdminRoute()
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}

  @Get()
  @ApiOperation({ summary: 'List users', description: 'Paginated list of all users with optional search and status filter.' })
  @ApiResponse({ status: 200, description: 'User list returned.' })
  listUsers(
    @Query() query: UserListQueryDto,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.service.listUsers(query.page!, query.limit!, query.search, query.status, query.sortBy, query.sortOrder, admin.role);
  }

  @Get(':userId')
  @ApiOperation({ summary: 'Get user detail', description: 'Returns full user detail including wallet and KYC history.' })
  @ApiResponse({ status: 200, description: 'User detail returned.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  getUserDetail(
    @Param('userId', ParseIdPipe) userId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.getUserDetail(userId, admin.sub, req.ip || 'unknown', admin.role);
  }

  @Get(':userId/orders')
  @ApiOperation({ summary: 'List user orders', description: 'Paginated list of orders for a specific user (as buyer or seller).' })
  @ApiResponse({ status: 200, description: 'User orders returned.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  getUserOrders(
    @Param('userId', ParseIdPipe) userId: string,
    @Query() query: UserOrderQueryDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.getUserOrders(userId, query.page!, query.limit!, query.status, admin.sub, req.ip || 'unknown');
  }

  @Get(':userId/wallet')
  @ApiOperation({ summary: 'Get user wallet', description: 'Returns wallet details with paginated transactions (page/limit; default 10, max 100).' })
  @ApiResponse({ status: 200, description: 'User wallet returned.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  getUserWallet(
    @Param('userId', ParseIdPipe) userId: string,
    @Query() pagination: PaginationDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.getUserWallet(userId, admin.sub, req.ip || 'unknown', pagination.page ?? 1, pagination.limit ?? 10);
  }

  @Get(':userId/sessions')
  @ApiOperation({ summary: 'List user sessions', description: 'Returns active sessions for a specific user.' })
  @ApiResponse({ status: 200, description: 'User sessions returned.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  getUserSessions(
    @Param('userId', ParseIdPipe) userId: string,
    @Query() pagination: PaginationDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.getUserSessions(userId, pagination.page, pagination.limit, admin.sub, req.ip || 'unknown');
  }

  @Post(':userId/wallet/adjust')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @Idempotency()
  @ApiOperation({ summary: 'Adjust user wallet', description: 'Manual wallet credit or debit. SUPER_ADMIN only.' })
  @ApiResponse({ status: 200, description: 'Wallet adjusted.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role.' })
  @ApiResponse({ status: 404, description: 'User or wallet not found.' })
  adjustWallet(
    @Param('userId', ParseIdPipe) userId: string,
    @Body() dto: WalletAdjustDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<{ txId: string; type: string; amount: number; reason: string; balanceAfter: number }> {
    return this.service.adjustWallet(userId, dto, admin.sub, req.ip || 'unknown');
  }

  @Get(':userId/audit-log')
  @ApiOperation({ summary: 'User audit log', description: 'Returns the activity audit trail for a specific user.' })
  @ApiResponse({ status: 200, description: 'User audit log returned.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  getUserAuditLog(
    @Param('userId', ParseIdPipe) userId: string,
    @Query() pagination: PaginationDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.getUserAuditLog(userId, pagination.page!, pagination.limit!, admin.sub, req.ip || 'unknown');
  }

  @Post(':userId/reset-password')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Trigger password reset email for user', description: 'Generates a password reset OTP and emails it to the user.' })
  @ApiResponse({ status: 200, description: 'Password reset email sent.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  resetUserPassword(
    @Param('userId', ParseIdPipe) userId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.resetUserPassword(userId, admin.sub, req.ip || 'unknown');
  }

  @Post(':userId/force-logout')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Force logout user', description: 'Revokes all active sessions for a user, forcing logout.' })
  @ApiResponse({ status: 200, description: 'User sessions revoked.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  forceLogout(@Param('userId', ParseIdPipe) userId: string, @CurrentAdmin() admin: AdminJwtPayload, @Req() req: Request): Promise<{ message: string; revokedCount: number }> {
    return this.service.forceLogout(userId, admin.sub, req.ip || 'unknown');
  }

  @Delete(':userId/sessions/:sessionId')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'CUSTOMER_SUPPORT')
  @ApiOperation({ summary: 'Revoke a specific user session', description: 'Revokes one session by ID without affecting other active sessions.' })
  @ApiResponse({ status: 200, description: 'Session revoked.' })
  @ApiResponse({ status: 404, description: 'User or session not found.' })
  revokeUserSession(
    @Param('userId', ParseIdPipe) userId: string,
    @Param('sessionId', ParseIdPipe) sessionId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.revokeUserSession(userId, sessionId, admin.sub, req.ip || 'unknown');
  }

  @Post(':userId/ban')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Ban user', description: 'Bans a user with a required reason. ADMIN and SUPER_ADMIN only.' })
  @ApiResponse({ status: 200, description: 'User banned.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role or user already banned.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  banUser(
    @Param('userId', ParseIdPipe) userId: string,
    @Body() dto: BanUserDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.banUser(userId, dto.reason, admin.sub, req.ip || 'unknown');
  }

  @Post(':userId/unban')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Unban user', description: 'Removes a ban from a user. ADMIN and SUPER_ADMIN only.' })
  @ApiResponse({ status: 200, description: 'User unbanned.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  unbanUser(@Param('userId', ParseIdPipe) userId: string, @CurrentAdmin() admin: AdminJwtPayload, @Req() req: Request): Promise<object> {
    return this.service.unbanUser(userId, admin.sub, req.ip || 'unknown');
  }

  // Tier verified 3 tingkat (koreksi model 2026-09-26):
  //  - Emas (TRUSTED_BY_KAHADE): manual ke customer pilihan — grant/revoke di bawah.
  //  - Abu (FULLY_VERIFIED): otomatis, tapi bisa di-revoke/restore manual.
  //  - Bisnis: via modul business-verification (bukan di controller ini).
  // Badge (Badge/UserBadge) adalah domain terpisah untuk event/pencapaian.

  @Post(':userId/verified/gold/grant')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Grant gold verified tier', description: 'Memberikan tier emas (Dipercaya Kahade) ke customer pilihan. Hanya SUPER_ADMIN.' })
  @ApiResponse({ status: 200, description: 'Gold tier granted.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  grantGoldVerified(
    @Param('userId', ParseIdPipe) userId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.grantGoldVerified(userId, admin.sub, req.ip || 'unknown');
  }

  @Post(':userId/verified/gold/revoke')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Revoke gold verified tier', description: 'Mencabut tier emas (Dipercaya Kahade). vipGrantedAt dipertahankan untuk audit. Hanya SUPER_ADMIN.' })
  @ApiResponse({ status: 200, description: 'Gold tier revoked.' })
  @ApiResponse({ status: 400, description: 'User does not hold the gold tier.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  revokeGoldVerified(
    @Param('userId', ParseIdPipe) userId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.revokeGoldVerified(userId, admin.sub, req.ip || 'unknown');
  }

  @Post(':userId/verified/gray/revoke')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Revoke gray verified tier', description: 'Mencabut tier abu (Terverifikasi Penuh) manual. Syarat otomatis tidak diubah; badge hilang sampai di-restore. SUPER_ADMIN only (ADM-410).' })
  @ApiResponse({ status: 200, description: 'Gray tier revoked.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role, or cannot revoke own tier.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  @ApiResponse({ status: 409, description: 'Gray tier already revoked.' })
  revokeGrayVerified(
    @Param('userId', ParseIdPipe) userId: string,
    @Body() dto: GrayRevokeDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.revokeGrayVerified(userId, dto.reason, admin.sub, admin.email, req.ip || 'unknown');
  }

  @Post(':userId/verified/gray/restore')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Restore gray verified tier', description: 'Mengembalikan tier abu (Terverifikasi Penuh) yang sebelumnya di-revoke. SUPER_ADMIN only (ADM-410).' })
  @ApiResponse({ status: 200, description: 'Gray tier restored.' })
  @ApiResponse({ status: 400, description: 'Gray tier is not revoked.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  restoreGrayVerified(
    @Param('userId', ParseIdPipe) userId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.restoreGrayVerified(userId, admin.sub, req.ip || 'unknown');
  }

  // Section 6: menutup flag `flaggedForReview` setelah admin mereview laporan
  // dan menyimpulkan tidak ada pelanggaran. Flag ini dipasang otomatis oleh
  // ReportFlagService (>= 3 reporter berbeda dalam 24 jam) dan TIDAK pernah
  // memicu sanksi otomatis — ban tetap lewat POST :userId/ban.
  @Post(':userId/review-flag/clear')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'CUSTOMER_SUPPORT')
  @ApiOperation({
    summary: 'Clear the automatic moderation review flag',
    description:
      'Menghapus `flaggedForReview` setelah admin mereview agregasi laporan dan memutuskan tidak ada pelanggaran. ' +
      'Flag dipasang otomatis saat >= 3 user berbeda melaporkan target dalam 24 jam; tidak ada auto-ban, ' +
      'sehingga route ini adalah jalur "direview, tidak ada tindakan". Idempoten terhadap klik ganda ' +
      '(409 bila state sudah berubah).',
  })
  @ApiResponse({ status: 200, description: 'Review flag cleared.' })
  @ApiResponse({ status: 400, description: 'User is not flagged for review.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role (SUPER_ADMIN or CUSTOMER_SUPPORT only).' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  @ApiResponse({ status: 409, description: 'Flag state changed concurrently.' })
  clearReviewFlag(@Param('userId', ParseIdPipe) userId: string, @CurrentAdmin() admin: AdminJwtPayload, @Req() req: Request): Promise<object> {
    return this.service.clearReviewFlag(userId, admin.sub, req.ip || 'unknown');
  }

  @Get(':userId/moderation-events')
  @ApiOperation({
    summary: 'Timeline moderasi pengguna',
    description:
      'Menggabungkan AdminAuditLog (targetType User), keputusan KYC, resolusi laporan, ' +
      'dan flag otomatis menjadi satu timeline terurut dengan flag source system|admin. ' +
      'Catatan internal disembunyikan dari role CUSTOMER_SUPPORT.',
  })
  @ApiResponse({ status: 200, description: 'Moderation timeline returned.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  listModerationEvents(
    @Param('userId', ParseIdPipe) userId: string,
    @Query() query: ModerationEventsQueryDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.listModerationEvents(userId, query, admin.role, admin.sub, req.ip || 'unknown');
  }

  @Post('export')
  @AdminRoles('SUPER_ADMIN')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({
    summary: 'Ekspor CSV pengguna via body (kontrak admin web)',
    description:
      'Sama seperti GET export/csv tetapi menerima body JSON: { reason, columns, mask, search, status }. ' +
      'reason WAJIB. Dataset > 5000 baris → 202 { jobId }.',
  })
  @ApiResponse({ status: 200, description: 'CSV file returned.' })
  @ApiResponse({ status: 202, description: 'Export accepted — poll job status.' })
  async exportViaBody(
    @Body() dto: UserExportBodyDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const query: UserExportQueryDto = Object.assign(new UserExportQueryDto(), {
      reason: dto.reason,
      columns: dto.columns && dto.columns.length > 0 ? dto.columns.join(',') : undefined,
      mask: dto.mask,
      search: dto.search,
      status: dto.status,
    });
    const result = await this.service.exportUsersCsv(query, admin.role, admin.sub, req.ip || 'unknown');
    if (result.kind === 'async') {
      res.status(HttpStatus.ACCEPTED).json({
        jobId: result.jobId,
        status: 'pending',
        rowCount: result.rowCount,
        pollUrl: `/v1/admin/users/export/jobs/${result.jobId}`,
        message: 'Dataset besar — ekspor diproses di latar. Poll URL di atas untuk tautan unduh.',
      });
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.csv);
  }

  @Get('export/csv')
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({
    summary: 'Ekspor CSV pengguna (diperkuat, G380)',
    description:
      'Alasan (reason) wajib dan tercatat di UserExportAudit + AdminAuditLog. ' +
      'Kolom opsional (default minimal), masking PII default aktif. ' +
      'Dataset > 5000 baris → 202 + jobId (poll /export/jobs/:jobId untuk tautan unduh privat 15 menit).',
  })
  @ApiResponse({ status: 200, description: 'CSV file returned.' })
  @ApiResponse({ status: 202, description: 'Export accepted — poll job status.' })
  async exportCsv(
    @Query() query: UserExportQueryDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.service.exportUsersCsv(query, admin.role, admin.sub, req.ip || 'unknown');
    if (result.kind === 'async') {
      res.status(HttpStatus.ACCEPTED).json({
        jobId: result.jobId,
        status: 'pending',
        rowCount: result.rowCount,
        pollUrl: `/v1/admin/users/export/jobs/${result.jobId}`,
        message: 'Dataset besar — ekspor diproses di latar. Poll URL di atas untuk tautan unduh.',
      });
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.csv);
  }

  @Get('export/jobs/:jobId')
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Poll status job ekspor CSV async' })
  @ApiResponse({ status: 200, description: 'Job status returned (ready → downloadUrl 15 menit).' })
  @ApiResponse({ status: 404, description: 'Job not found or expired.' })
  exportJobStatus(
    @Param('jobId') jobId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.service.getExportJobStatus(jobId, admin.sub);
  }

  // ADM-401: endpoint POST :userId/impersonate DIHAPUS total (2026-09-27).
  // Token impersonate sebelumnya adalah string unsigned `imp_<adminId>_<userId>_<timestamp>`
  // (self-asserted, mudah ditebak, tanpa validasi server-side) — tidak boleh ada di produk keuangan.
  // Sampai ada desain impersonasi yang benar (scoped JWT 5 menit, single-use, diaudit),
  // endpoint ini tidak dikembalikan.

  // ─────────────────────────────────────────────────────────────────
  // GAP-A (G067): status penghapusan akun + legal hold.
  // ─────────────────────────────────────────────────────────────────

  @Get(':userId/deletion')
  @ApiOperation({
    summary: 'Lihat status penghapusan akun',
    description: 'Permintaan penghapusan terbaru user beserta riwayat status (read-only).',
  })
  @ApiResponse({ status: 200, description: 'Deletion status returned.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  getDeletionStatus(@Param('userId', ParseIdPipe) userId: string): Promise<object> {
    return this.service.getDeletionStatus(userId);
  }

  @Post(':userId/deletion/legal-hold')
  // ADM-413: legal hold adalah tindakan berkonsekuensi hukum (menahan hak hapus data) —
  // hanya SUPER_ADMIN. CUSTOMER_SUPPORT tidak lagi bisa menaruh/melepas hold.
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({
    summary: 'Tahan penghapusan (legal hold)',
    description:
      'Ubah request aktif menjadi ON_HOLD karena sengketa/retensi hukum. ' +
      'Purge worker melewati request ON_HOLD.',
  })
  @ApiResponse({ status: 200, description: 'Legal hold placed.' })
  @ApiResponse({ status: 404, description: 'No active deletion request.' })
  placeDeletionLegalHold(
    @Param('userId', ParseIdPipe) userId: string,
    @Body() dto: DeletionLegalHoldDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.placeDeletionLegalHold(userId, dto.reason, admin.sub, req.ip || 'unknown');
  }

  @Post(':userId/deletion/release-hold')
  // ADM-413: lihat catatan pada legal-hold — hanya SUPER_ADMIN.
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({
    summary: 'Lepas legal hold penghapusan',
    description: 'Kembalikan request ON_HOLD menjadi aktif (REQUESTED) dengan purgeAt yang sama.',
  })
  @ApiResponse({ status: 200, description: 'Legal hold released.' })
  @ApiResponse({ status: 404, description: 'No ON_HOLD deletion request.' })
  releaseDeletionLegalHold(
    @Param('userId', ParseIdPipe) userId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.releaseDeletionLegalHold(userId, admin.sub, req.ip || 'unknown');
  }
}
