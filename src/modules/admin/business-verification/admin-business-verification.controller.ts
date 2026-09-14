import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminBusinessVerificationService } from './admin-business-verification.service';
import { BusinessVerificationQueueQueryDto } from './dto/business-verification-queue-query.dto';
import { ReviewBusinessVerificationDto } from './dto/review-business-verification.dto';
import { RejectBusinessVerificationDto } from './dto/reject-business-verification.dto';
import { RevokeBusinessVerificationDto } from './dto/revoke-business-verification.dto';
import { GetBusinessDocumentUrlsDto } from './dto/get-business-document-urls.dto';
import { AdminRoute } from '../../../common/decorators/public.decorator';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';

/**
 * Section 1(d) — admin console untuk verifikasi badan usaha.
 * Struktur route sengaja identik dengan AdminKycController supaya tim admin
 * tidak perlu mempelajari pola baru: queue / detail / document-urls / approve /
 * reject / revoke.
 */
@ApiTags('admin-business-verification')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
@AdminRoute()
@Controller('admin/business-verifications')
export class AdminBusinessVerificationController {
  constructor(private readonly service: AdminBusinessVerificationService) {}

  @Get()
  @ApiOperation({
    summary: 'Get business verification queue',
    description: 'Antrian verifikasi badan usaha (FIFO), bisa difilter per status.',
  })
  @ApiResponse({ status: 200, description: 'Queue dikembalikan.' })
  getQueue(@Query() query: BusinessVerificationQueueQueryDto): Promise<object> {
    return this.service.getQueue(query.page ?? 1, query.limit ?? 20, query.status);
  }

  @Get(':verificationId')
  @ApiOperation({
    summary: 'Get business verification detail',
    description: 'Detail pengajuan. NPWP TIDAK dikembalikan di sini — gunakan /document-urls (butuh re-auth).',
  })
  @ApiResponse({ status: 200, description: 'Detail dikembalikan.' })
  @ApiResponse({ status: 404, description: 'Pengajuan tidak ditemukan.' })
  getDetail(
    @Param('verificationId', ParseIdPipe) verificationId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    return this.service.getDetail(verificationId, admin.sub, req.ip || 'unknown');
  }

  @Post(':verificationId/document-urls')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({
    summary: 'Get short-lived signed URLs for business documents',
    description:
      'Mendekripsi fileKey dokumen dan mengembalikan signed URL 5 menit + NPWP plaintext. ' +
      'Wajib re-authentication dengan password admin. KYC_ADMIN dan SUPER_ADMIN only.',
  })
  @ApiResponse({ status: 200, description: 'Signed URLs dikembalikan (kadaluarsa 300 s).' })
  @ApiResponse({ status: 401, description: 'Re-authentication gagal.' })
  @ApiResponse({ status: 404, description: 'Pengajuan tidak ditemukan.' })
  getDocumentUrls(
    @Param('verificationId', ParseIdPipe) verificationId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
    @Body() dto: GetBusinessDocumentUrlsDto,
  ): Promise<{ npwpNumber: string | null; documentUrls: string[]; partialErrors?: string[] }> {
    return this.service.getDocumentUrls(verificationId, admin.sub, req.ip || 'unknown', dto.password);
  }

  @Post(':verificationId/approve')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({
    summary: 'Approve business verification',
    description: 'Menyetujui pengajuan PENDING dan langsung mengaktifkan badge "Business Verified".',
  })
  @ApiResponse({ status: 200, description: 'Disetujui — status APPROVED, approvedAt terisi.' })
  @ApiResponse({ status: 400, description: 'Pengajuan bukan PENDING.' })
  @ApiResponse({ status: 403, description: 'Role admin tidak cukup.' })
  @ApiResponse({ status: 404, description: 'Pengajuan tidak ditemukan.' })
  approve(
    @Param('verificationId', ParseIdPipe) verificationId: string,
    @Body() dto: ReviewBusinessVerificationDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    return this.service.approve(verificationId, admin.sub, dto.notes, req.ip || 'unknown');
  }

  @Post(':verificationId/reject')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({
    summary: 'Reject business verification',
    description: 'Menolak pengajuan PENDING dengan alasan wajib. User boleh resubmit setelah 24 jam.',
  })
  @ApiResponse({ status: 200, description: 'Ditolak — status REJECTED.' })
  @ApiResponse({ status: 400, description: 'Pengajuan bukan PENDING.' })
  @ApiResponse({ status: 403, description: 'Role admin tidak cukup.' })
  @ApiResponse({ status: 404, description: 'Pengajuan tidak ditemukan.' })
  reject(
    @Param('verificationId', ParseIdPipe) verificationId: string,
    @Body() dto: RejectBusinessVerificationDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    return this.service.reject(verificationId, admin.sub, dto.reason, dto.notes, req.ip || 'unknown');
  }

  @Post(':verificationId/revoke')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({
    summary: 'Revoke business verification',
    description: 'Mencabut verifikasi yang sudah APPROVED. Badge "Business Verified" langsung hilang. SUPER_ADMIN only.',
  })
  @ApiResponse({ status: 200, description: 'Dicabut — status REVOKED, revokedAt terisi.' })
  @ApiResponse({ status: 400, description: 'Pengajuan bukan APPROVED.' })
  @ApiResponse({ status: 403, description: 'Role admin tidak cukup.' })
  @ApiResponse({ status: 404, description: 'Pengajuan tidak ditemukan.' })
  revoke(
    @Param('verificationId', ParseIdPipe) verificationId: string,
    @Body() dto: RevokeBusinessVerificationDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    return this.service.revoke(verificationId, admin.sub, dto.reason, req.ip || 'unknown');
  }

  @Post('bulk/approve')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({ summary: 'Bulk approve business verifications (max 50)' })
  async bulkApprove(
    @Body() dto: { verificationIds: string[]; notes?: string },
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    const approved: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const id of dto.verificationIds.slice(0, 50)) {
      try {
        await this.service.approve(id, admin.sub, dto.notes, req.ip || 'unknown');
        approved.push(id);
      } catch (e) {
        failed.push({ id, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { approved, failed };
  }

  @Post('bulk/reject')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({ summary: 'Bulk reject business verifications (max 50)' })
  async bulkReject(
    @Body() dto: { verificationIds: string[]; reason: string; notes?: string },
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    const rejected: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const id of dto.verificationIds.slice(0, 50)) {
      try {
        await this.service.reject(id, admin.sub, dto.reason, dto.notes, req.ip || 'unknown');
        rejected.push(id);
      } catch (e) {
        failed.push({ id, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { rejected, failed };
  }
}
