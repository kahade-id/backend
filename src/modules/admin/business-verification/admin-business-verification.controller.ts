import { Body, Controller, Get, Header, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminBusinessVerificationService } from './admin-business-verification.service';
import { BusinessVerificationQueueQueryDto } from './dto/business-verification-queue-query.dto';
import { ReviewBusinessVerificationDto } from './dto/review-business-verification.dto';
import { RejectBusinessVerificationDto } from './dto/reject-business-verification.dto';
import { RevokeBusinessVerificationDto } from './dto/revoke-business-verification.dto';
import { GetBusinessDocumentUrlsDto } from './dto/get-business-document-urls.dto';
import {
  BulkApproveBusinessVerificationDto,
  BulkRejectBusinessVerificationDto,
  BULK_BUSINESS_VERIFICATION_MAX,
} from './dto/bulk-review-business-verification.dto';
import { AssignBusinessReviewerDto } from './dto/assign-business-reviewer.dto';
import { BusinessVerificationSummaryQueryDto } from './dto/business-verification-summary-query.dto';
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
 *
 * PENTING (urutan route): route literal (`bulk/*`, `summary`, `export`)
 * dideklarasikan SEBELUM `:verificationId` — Express/Nest mencocokkan
 * berdasarkan urutan deklarasi, dan `POST bulk/approve` akan tertelan pola
 * `POST :verificationId/approve` bila dideklarasikan sesudahnya.
 */
@ApiTags('admin-business-verification')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
@AdminRoute()
@Controller('admin/business-verifications')
export class AdminBusinessVerificationController {
  constructor(private readonly service: AdminBusinessVerificationService) {}

  /** batchId unik per operasi bulk — tampil di UI & dicatat di tiap audit item. */
  private newBatchId(): string {
    const now = new Date();
    const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `BVB-${stamp}-${rand}`;
  }

  @Post('bulk/approve')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({
    summary: `Bulk approve business verifications (max ${BULK_BUSINESS_VERIFICATION_MAX})`,
    description:
      'Menyetujui banyak pengajuan PENDING sekaligus. Tiap item diproses ' +
      'terpisah (guard atomik per item); hasil per item dikembalikan. ' +
      'batchId unik dicatat di audit tiap item yang berhasil.',
  })
  @ApiResponse({ status: 200, description: 'Hasil per item + batchId dikembalikan.' })
  async bulkApprove(
    @Body() dto: BulkApproveBusinessVerificationDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    const batchId = this.newBatchId();
    const approved: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const id of dto.verificationIds.slice(0, BULK_BUSINESS_VERIFICATION_MAX)) {
      try {
        await this.service.approve(id, admin.sub, dto.notes, req.ip || 'unknown', batchId);
        approved.push(id);
      } catch (e) {
        failed.push({ id, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { batchId, approved, failed };
  }

  @Post('bulk/reject')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({
    summary: `Bulk reject business verifications (max ${BULK_BUSINESS_VERIFICATION_MAX})`,
    description:
      'Menolak banyak pengajuan PENDING sekaligus dengan SATU alasan wajib ' +
      'yang dikirim ke tiap pemohon secara individual. batchId unik dicatat ' +
      'di audit tiap item yang berhasil.',
  })
  @ApiResponse({ status: 200, description: 'Hasil per item + batchId dikembalikan.' })
  async bulkReject(
    @Body() dto: BulkRejectBusinessVerificationDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    const batchId = this.newBatchId();
    const rejected: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const id of dto.verificationIds.slice(0, BULK_BUSINESS_VERIFICATION_MAX)) {
      try {
        await this.service.reject(id, admin.sub, dto.reason, dto.notes, req.ip || 'unknown', batchId);
        rejected.push(id);
      } catch (e) {
        failed.push({ id, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { batchId, rejected, failed };
  }

  @Get('summary')
  @ApiOperation({
    summary: 'Volume summary: approved/rejected/revoked per period',
    description: 'Ringkasan operasional: jumlah disetujui/ditolak/dicabut dalam periode + kedalaman antrean PENDING saat ini.',
  })
  @ApiResponse({ status: 200, description: 'Ringkasan dikembalikan.' })
  getSummary(@Query() query: BusinessVerificationSummaryQueryDto): Promise<object> {
    const period = query.period === '7d' || query.period === '90d' ? query.period : '30d';
    return this.service.getSummary(period);
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @ApiOperation({
    summary: 'Export business verification queue as CSV (tanpa NPWP)',
    description:
      'Ekspor antrean mengikuti filter query yang sama. NPWP TIDAK PERNAH ' +
      'disertakan — kolom npwpNumber/npwpNumberHash tidak di-select.',
  })
  @ApiResponse({ status: 200, description: 'CSV dikembalikan.' })
  exportCsv(@Query() query: BusinessVerificationQueueQueryDto): Promise<string> {
    return this.service.exportCsv(query);
  }

  @Get()
  @ApiOperation({
    summary: 'Get business verification queue',
    description:
      'Antrian verifikasi badan usaha (FIFO), bisa difilter per status, ' +
      'jenis badan hukum, kelengkapan dokumen, dan "menunggu dokumen tambahan".',
  })
  @ApiResponse({ status: 200, description: 'Queue dikembalikan.' })
  getQueue(@Query() query: BusinessVerificationQueueQueryDto): Promise<object> {
    return this.service.getQueue(query.page ?? 1, query.limit ?? 20, query);
  }

  @Get(':verificationId/history')
  @ApiOperation({
    summary: 'Audit history for one business verification',
    description: 'Riwayat perubahan/audit: penugasan reviewer, akses dokumen, keputusan review.',
  })
  @ApiResponse({ status: 200, description: 'Riwayat dikembalikan.' })
  @ApiResponse({ status: 404, description: 'Pengajuan tidak ditemukan.' })
  getHistory(
    @Param('verificationId', ParseIdPipe) verificationId: string,
  ): Promise<object> {
    return this.service.getHistory(verificationId);
  }

  @Get(':verificationId')
  @ApiOperation({
    summary: 'Get business verification detail',
    description:
      'Detail pengajuan. NPWP hanya dalam bentuk MASKED (preview minim-PII) — ' +
      'NPWP mentah tetap hanya lewat /document-urls (butuh re-auth).',
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

  @Post(':verificationId/assign')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({
    summary: 'Assign a reviewer to a business verification',
    description:
      'Menugaskan reviewer (admin aktif). Tidak mengubah status pengajuan. ' +
      'Penugasan dicatat di audit log.',
  })
  @ApiResponse({ status: 200, description: 'Reviewer ditugaskan.' })
  @ApiResponse({ status: 400, description: 'Reviewer tidak valid.' })
  @ApiResponse({ status: 404, description: 'Pengajuan tidak ditemukan.' })
  assignReviewer(
    @Param('verificationId', ParseIdPipe) verificationId: string,
    @Body() dto: AssignBusinessReviewerDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    return this.service.assignReviewer(verificationId, dto.adminId, admin.sub, req.ip || 'unknown');
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
    description:
      'Mencabut verifikasi yang sudah APPROVED. Badge "Business Verified" langsung hilang. ' +
      'SUPER_ADMIN only. Catatan internal (notes) terpisah dari alasan pencabutan.',
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
    return this.service.revoke(verificationId, admin.sub, dto.reason, req.ip || 'unknown', dto.notes);
  }
}
