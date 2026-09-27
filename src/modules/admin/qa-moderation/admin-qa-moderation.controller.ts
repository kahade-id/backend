/**
 * GAP-F (G426–G450): Moderasi platform Q&A profil — controller admin.
 *
 * JALUR MODERATOR PLATFORM. Guard: endpoint ini memakai JwtAdminGuard
 * (token admin, aud kahade-admin-api) — token user biasa DITOLAK, sehingga
 * pemilik profil tidak bisa memakai endpoint admin (G428). RBAC: lihat matriks
 * di backend/docs/moderation-qa-policy.md — CUSTOMER_SUPPORT boleh
 * lihat+hide/unhide; hapus permanen & approval HANYA SUPER_ADMIN (G447).
 */
import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import {
  Controller, Get, Post, Param, Body, Query, UseGuards, Header,
  DefaultValuePipe, ParseIntPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRole } from '@prisma/client';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { AdminQaModerationService } from './admin-qa-moderation.service';
import { QaModerationQueueQueryDto } from './dto/qa-moderation-queue-query.dto';
import { QaModeratorHideDto, QaModeratorUnhideDto, QaBulkHideDto, QaBulkUnhideDto } from './dto/qa-moderate.dto';
import {
  QaRedactDto,
  QaAssignDto,
  QaAppealReviewDto,
  QaDeleteRequestDto,
  QaDeleteDecisionDto,
  QaReportResolveDto,
} from './dto/qa-moderation-actions.dto';

@ApiTags('admin-qa-moderation')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.CUSTOMER_SUPPORT)
@AdminRoute()
@Controller('admin/qa-moderation')
export class AdminQaModerationController {
  constructor(private readonly service: AdminQaModerationService) {}

  @Get('queue')
  @ApiOperation({
    summary: 'Antrean moderasi Q&A (G426)',
    description:
      'Item pertanyaan/komentar yang dilaporkan atau disembunyikan. Pagination + pencarian teks/username. Username dimask parsial, tanpa nomor HP/email (G433).',
  })
  getQueue(@Query() query: QaModerationQueueQueryDto): Promise<object> {
    return this.service.getQueue(query);
  }

  @Get('metrics')
  @ApiOperation({
    summary: 'Metrik antrean (G445)',
    description: 'Jumlah open, rata-rata waktu penyelesaian, distribusi reason code.',
  })
  getMetrics(): Promise<object> {
    return this.service.getMetrics();
  }

  @Get('spam-candidates')
  @ApiOperation({
    summary: 'Kandidat spam lintas profil (G440)',
    description:
      'Heuristik: teks identik dari author yang sama di >N profil berbeda dalam 24 jam.',
  })
  getSpamCandidates(
    @Query('threshold', new DefaultValuePipe(3), ParseIntPipe) threshold: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ): Promise<object> {
    return this.service.getSpamCandidates(threshold, limit);
  }

  @Get('export')
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="qa-moderation-audit.csv"')
  @ApiOperation({
    summary: 'Ekspor audit agregat CSV (G448)',
    description: 'Counts per reason/day. Tanpa teks konten massal; hanya SUPER_ADMIN.',
  })
  exportCsv(@Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number): Promise<string> {
    return this.service.exportAggregateCsv(days);
  }

  @Get('appeals')
  @ApiOperation({ summary: 'Daftar keberatan (appeal) atas hide moderator (G436)' })
  listAppeals(
    @Query('status') status: string | undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ): Promise<object> {
    return this.service.listAppeals(status, page, limit);
  }

  @Get('delete-requests')
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Daftar request hapus permanen (G435)' })
  listDeleteRequests(@Query('status') status: string | undefined): Promise<object> {
    return this.service.listDeleteRequests(status);
  }

  @Get('questions/:id')
  @ApiOperation({
    summary: 'Detail pertanyaan + konteks thread (G432/G438)',
    description: 'Pertanyaan + maks 10 komentar terkait, laporan, histori aksi, appeal, delete request.',
  })
  getQuestionDetail(@Param('id', ParseIdPipe) id: string): Promise<object> {
    return this.service.getQuestionDetail(id);
  }

  @Get('comments/:id')
  @ApiOperation({ summary: 'Detail komentar + konteks thread (G432/G438)' })
  getCommentDetail(@Param('id', ParseIdPipe) id: string): Promise<object> {
    return this.service.getCommentDetail(id);
  }

  // ---- hide / unhide jalur moderator (G428) ----

  @Post('questions/:id/hide')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Idempotency()
  @ApiOperation({
    summary: 'Hide pertanyaan — jalur MODERATOR (G428)',
    description:
      'Tidak memakai endpoint self-service pemilik. Mencatat hidden_by_type=MODERATOR + event audit + notifikasi netral ke penulis.',
  })
  @ApiResponse({ status: 409, description: 'Target sudah disembunyikan.' })
  hideQuestion(
    @CurrentAdmin('sub') adminId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: QaModeratorHideDto,
  ): Promise<object> {
    return this.service.moderatorHide(adminId, 'QUESTION', id, dto.reasonCode, dto.note);
  }

  @Post('questions/:id/unhide')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Idempotency()
  @ApiOperation({ summary: 'Unhide pertanyaan — jalur MODERATOR' })
  unhideQuestion(
    @CurrentAdmin('sub') adminId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: QaModeratorUnhideDto,
  ): Promise<object> {
    // Body opsional (note saja); tidak butuh reasonCode untuk unhide.
    return this.service.moderatorUnhide(adminId, 'QUESTION', id, dto?.note);
  }

  @Post('comments/:id/hide')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Idempotency()
  @ApiOperation({ summary: 'Hide komentar — jalur MODERATOR (G428)' })
  hideComment(
    @CurrentAdmin('sub') adminId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: QaModeratorHideDto,
  ): Promise<object> {
    return this.service.moderatorHide(adminId, 'COMMENT', id, dto.reasonCode, dto.note);
  }

  @Post('comments/:id/unhide')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Idempotency()
  @ApiOperation({ summary: 'Unhide komentar — jalur MODERATOR' })
  unhideComment(
    @CurrentAdmin('sub') adminId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: QaModeratorUnhideDto,
  ): Promise<object> {
    return this.service.moderatorUnhide(adminId, 'COMMENT', id, dto?.note);
  }

  // ---- redaksi PII (G434) ----

  @Post('redact')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({
    summary: 'Redaksi PII di teks (G434)',
    description:
      'Deteksi no HP/email/NIK/rekening via regex; simpan versi teredaksi di redacted_text tanpa mengubah original.',
  })
  redact(
    @CurrentAdmin('sub') adminId: string,
    @Body() dto: QaRedactDto,
  ): Promise<object> {
    return this.service.redact(adminId, dto.targetType, dto.targetId);
  }

  // ---- bulk (G441/G442) ----

  @Post('bulk-hide')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Bulk hide (G442)',
    description: 'Maks 50/request, wajib confirm=true (G441). Hasil parsial per item.',
  })
  bulkHide(
    @CurrentAdmin('sub') adminId: string,
    @Body() dto: QaBulkHideDto,
  ): Promise<object> {
    return this.service.bulkHide(adminId, dto.targetType, dto.ids, dto.reasonCode, dto.note, dto.confirm);
  }

  @Post('bulk-unhide')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Bulk unhide (G442)' })
  bulkUnhide(
    @CurrentAdmin('sub') adminId: string,
    @Body() dto: QaBulkUnhideDto,
  ): Promise<object> {
    return this.service.bulkUnhide(adminId, dto.targetType, dto.ids, dto.note, dto.confirm);
  }

  // ---- laporan: assign/handoff (G446) + resolve ----

  @Post('reports/:reportId/assign')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({
    summary: 'Assignment kasus / handoff antar moderator (G446)',
    description: 'Assign ke admin (UNDER_REVIEW) atau handoff ke admin lain; null = lepas.',
  })
  assignReport(
    @CurrentAdmin('sub') adminId: string,
    @Param('reportId', ParseIdPipe) reportId: string,
    @Body() dto: QaAssignDto,
  ): Promise<object> {
    return this.service.assignReport(adminId, reportId, dto.adminId);
  }

  @Post('reports/:reportId/resolve')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Resolve laporan (DISMISSED / ACTION_TAKEN)' })
  resolveReport(
    @CurrentAdmin('sub') adminId: string,
    @Param('reportId', ParseIdPipe) reportId: string,
    @Body() dto: QaReportResolveDto,
  ): Promise<object> {
    return this.service.resolveReport(adminId, reportId, dto.resolution, dto.note);
  }

  // ---- appeal (G436) ----

  @Post('appeals/:appealId/review')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({
    summary: 'Review keberatan (G436)',
    description: 'Reviewer wajib ≠ moderator yang melakukan hide. APPROVED → konten ditampilkan kembali.',
  })
  @ApiResponse({ status: 403, description: 'Reviewer adalah moderator yang hide.' })
  reviewAppeal(
    @CurrentAdmin('sub') adminId: string,
    @Param('appealId', ParseIdPipe) appealId: string,
    @Body() dto: QaAppealReviewDto,
  ): Promise<object> {
    return this.service.reviewAppeal(adminId, appealId, dto.decision, dto.note);
  }

  // ---- hapus permanen dua langkah (G435) — SUPER_ADMIN saja ----

  @Post('questions/:id/delete-request')
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @UseGuards(UserThrottleGuard)
  @ApiOperation({
    summary: 'Request hapus permanen pertanyaan (G435)',
    description: 'Langkah 1: SUPER_ADMIN mengajukan. Langkah 2: SUPER_ADMIN lain menyetujui.',
  })
  requestDeleteQuestion(
    @CurrentAdmin('sub') adminId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: QaDeleteRequestDto,
  ): Promise<object> {
    return this.service.requestDelete(adminId, 'QUESTION', id, dto.reason);
  }

  @Post('comments/:id/delete-request')
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Request hapus permanen komentar (G435)' })
  requestDeleteComment(
    @CurrentAdmin('sub') adminId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: QaDeleteRequestDto,
  ): Promise<object> {
    return this.service.requestDelete(adminId, 'COMMENT', id, dto.reason);
  }

  @Post('delete-requests/:requestId/approve')
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @UseGuards(UserThrottleGuard)
  @ApiOperation({
    summary: 'Approve hapus permanen (G435)',
    description: 'Hanya SUPER_ADMIN yang BERBEDA dari requester. Menjalankan hard delete + event DELETED.',
  })
  @ApiResponse({ status: 403, description: 'Approver sama dengan requester.' })
  approveDeleteRequest(
    @CurrentAdmin('sub') adminId: string,
    @Param('requestId', ParseIdPipe) requestId: string,
    @Body() dto: QaDeleteDecisionDto,
  ): Promise<object> {
    return this.service.decideDeleteRequest(adminId, requestId, true, dto?.note);
  }

  @Post('delete-requests/:requestId/reject')
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Reject request hapus permanen (G435)' })
  rejectDeleteRequest(
    @CurrentAdmin('sub') adminId: string,
    @Param('requestId', ParseIdPipe) requestId: string,
    @Body() dto: QaDeleteDecisionDto,
  ): Promise<object> {
    return this.service.decideDeleteRequest(adminId, requestId, false, dto?.note);
  }
}
