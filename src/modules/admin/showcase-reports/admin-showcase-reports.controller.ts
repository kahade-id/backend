import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
  Res,
} from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { AdminShowcaseReportsService } from './admin-showcase-reports.service';
import { ShowcaseReportListQueryDto } from './dto/showcase-report-list-query.dto';
import { ReviewShowcaseReportDto } from './dto/review-showcase-report.dto';
import { ReopenShowcaseReportDto } from './dto/reopen-showcase-report.dto';
import { AddModerationNoteDto } from './dto/add-moderation-note.dto';
import { AssignShowcaseReportDto } from './dto/assign-showcase-report.dto';
import { RestrictShowcaseDto } from './dto/restrict-showcase.dto';
import { DecideAppealDto } from './dto/decide-appeal.dto';
import { ModerationQueueQueryDto } from './dto/moderation-queue-query.dto';
import { ExportShowcaseReportsQueryDto } from './dto/export-showcase-reports-query.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRole } from '@prisma/client';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { ModerationReasonCodeValue } from './moderation-prisma.types';

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

  // ---------------------------------------------------------------------------
  // GAP-F (G401–G425): lifecycle moderasi pasca-final. Route statis dideklarasikan
  // SEBELUM `:reportId` agar tidak ditangkap sebagai ID laporan.
  // ---------------------------------------------------------------------------

  @Get('queue')
  @ApiOperation({
    summary: 'Priority moderation queue',
    description:
      'G411/G419 — antrean prioritas: skor risiko per laporan + badge overdue ' +
      '(SLA 24 jam risiko tinggi / 72 jam normal) + filter tier risiko & assignee.',
  })
  @ApiResponse({ status: 200, description: 'Priority queue returned.' })
  getModerationQueue(@Query() query: ModerationQueueQueryDto): Promise<object> {
    return this.service.getModerationQueue({
      page: query.page,
      limit: query.limit,
      riskTier: query.riskTier,
      overdueOnly: query.overdueOnly,
      sort: query.sort,
      assigneeAdminId: query.assigneeAdminId,
    });
  }

  @Get('appeals/pending')
  @ApiOperation({
    summary: 'List pending appeals',
    description: 'G405 — antrean banding (PENDING) untuk diputus reviewer.',
  })
  @ApiResponse({ status: 200, description: 'Pending appeals returned.' })
  listPendingAppeals(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<object> {
    return this.service.listPendingAppeals(Number(page) || 1, Number(limit) || 20);
  }

  @Get('export')
  @ApiOperation({
    summary: 'Export showcase reports',
    description:
      'G421 — export CSV/JSON teredaksi (tanpa PII pelapor/pemilik) untuk audit ' +
      'kepatuhan. Setiap baris dicatat sebagai event EXPORTED (G403).',
  })
  @ApiResponse({ status: 200, description: 'Export file returned.' })
  async exportShowcaseReports(
    @Query() query: ExportShowcaseReportsQueryDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const result = await this.service.exportShowcaseReports(
      {
        format: query.format,
        status: query.status,
        from: query.from,
        to: query.to,
        limit: query.limit,
      },
      admin.sub,
      req.ip ?? '',
    );
    const filename = `showcase-reports-${result.exportedAt.slice(0, 10)}.${result.format}`;
    res.setHeader('Content-Type', result.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Rows', String(result.rowCount));
    res.setHeader('X-Exported-At', result.exportedAt);
    res.send(result.content);
  }

  @Get(':reportId')
  @ApiOperation({
    summary: 'Get showcase report detail',
    description:
      'Returns full report detail including the reported showcase item, its images, owner, and reporter. ' +
      'G420 — termasuk histori semua aksi moderasi (moderationEvents), assignment aktif, dan banding.',
  })
  @ApiResponse({ status: 200, description: 'Showcase report detail returned.' })
  @ApiResponse({ status: 404, description: 'Showcase report not found.' })
  getShowcaseReportDetail(@Param('reportId', ParseIdPipe) reportId: string): Promise<object> {
    return this.service.getShowcaseReportDetail(reportId);
  }

  @Get(':reportId/related')
  @ApiOperation({
    summary: 'Related reports',
    description: 'G414 — laporan lain untuk showcaseId atau ownerId yang sama (maks. 50).',
  })
  @ApiResponse({ status: 200, description: 'Related reports returned.' })
  @ApiResponse({ status: 404, description: 'Showcase report not found.' })
  getRelatedReports(@Param('reportId', ParseIdPipe) reportId: string): Promise<object> {
    return this.service.getRelatedReports(reportId);
  }

  @Get(':reportId/reviewer-summary')
  @ApiOperation({
    summary: 'Evidence summary for second reviewer',
    description:
      'G418 — ringkasan bukti untuk reviewer kedua: snapshot keputusan, kondisi ' +
      'live item, histori event, banding, cluster. PII reporter diminimalkan ' +
      '(hanya id + username).',
  })
  @ApiResponse({ status: 200, description: 'Reviewer summary returned.' })
  @ApiResponse({ status: 404, description: 'Showcase report not found.' })
  getReviewerSummary(@Param('reportId', ParseIdPipe) reportId: string): Promise<object> {
    return this.service.getReviewerSummary(reportId);
  }

  @Get(':reportId/snapshot-diff')
  @ApiOperation({
    summary: 'Diff item snapshot vs current state',
    description:
      'G409/G410 — bandingkan snapshot JSON kondisi item saat keputusan final ' +
      'pertama dengan kondisi item saat ini.',
  })
  @ApiResponse({ status: 200, description: 'Snapshot diff returned.' })
  @ApiResponse({ status: 404, description: 'Showcase report or snapshot not found.' })
  getSnapshotDiff(@Param('reportId', ParseIdPipe) reportId: string): Promise<object> {
    return this.service.getSnapshotDiff(reportId);
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

  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @Post(':reportId/reopen')
  @ApiOperation({
    summary: 'Reopen a final showcase report',
    description:
      'G401 — buka kembali laporan berstatus final → UNDER_REVIEW. Hanya dari ' +
      'status final, alasan manual wajib (min. 10 karakter, G422), dan HANYA ' +
      'SUPER_ADMIN (CUSTOMER_SUPPORT → 403). Requires Idempotency-Key.',
  })
  @ApiResponse({ status: 200, description: 'Showcase report reopened.' })
  @ApiResponse({ status: 400, description: 'Report is not in a final status, or reason too short.' })
  @ApiResponse({ status: 403, description: 'Only SUPER_ADMIN can reopen reports.' })
  @ApiResponse({ status: 404, description: 'Showcase report not found.' })
  reopenShowcaseReport(
    @Param('reportId', ParseIdPipe) reportId: string,
    @Body() dto: ReopenShowcaseReportDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.reopenReport(
      reportId,
      dto.reason,
      dto.reasonCode as ModerationReasonCodeValue | undefined,
      admin.sub,
      req.ip ?? '',
    );
  }

  // -------------------------------------------------------------------------
  // SH-A-003 — restore item yang pernah di-takedown moderasi.
  // Kontrak exact: POST /v1/admin/showcase-reports/items/:id/restore-takedown,
  // SUPER_ADMIN only, audit-logged, set isActive=true, catat event RESTORED,
  // response 200 { ok: true, item } (bentuk item = GET detail existing).
  // Item yang dinonaktifkan owner (bukan takedown moderasi) → 400.
  // -------------------------------------------------------------------------
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @Post('items/:id/restore-takedown')
  @ApiOperation({
    summary: 'Restore a moderation-taken-down showcase item',
    description:
      'SH-A-003 — mengaktifkan kembali item etalase yang pernah di-takedown ' +
      'moderasi (isActive=false → true) + mencatat moderation event RESTORED. ' +
      'Hanya untuk item yang terbukti pernah di-takedown (ada event TAKEDOWN); ' +
      'item yang dinonaktifkan owner sendiri ditolak 400. Hanya SUPER_ADMIN. ' +
      'Requires Idempotency-Key.',
  })
  @ApiResponse({ status: 200, description: 'Takedown restored. Returns { ok: true, item }.' })
  @ApiResponse({ status: 400, description: 'Item already active, deleted, or was not taken down by moderation.' })
  @ApiResponse({ status: 403, description: 'Only SUPER_ADMIN can restore takedowns.' })
  @ApiResponse({ status: 404, description: 'Showcase item not found.' })
  restoreTakedown(
    @Param('id', ParseIdPipe) itemId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<{ ok: true; item: object }> {
    return this.service.restoreTakedownItem(admin.sub, itemId, req.ip ?? '');
  }

  @UseGuards(UserThrottleGuard)
  @Post(':reportId/notes')
  @ApiOperation({
    summary: 'Append a moderation note',
    description: 'G402 — tambah catatan moderasi (append-only; tidak menimpa resolution awal).',
  })
  @ApiResponse({ status: 200, description: 'Moderation note added.' })
  @ApiResponse({ status: 400, description: 'Note is empty or too long.' })
  @ApiResponse({ status: 404, description: 'Showcase report not found.' })
  addModerationNote(
    @Param('reportId', ParseIdPipe) reportId: string,
    @Body() dto: AddModerationNoteDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.addModerationNote(reportId, dto.note, admin.sub, req.ip ?? '');
  }

  @UseGuards(UserThrottleGuard)
  @Post(':reportId/assign')
  @ApiOperation({
    summary: 'Assign / handoff a report',
    description:
      'G411/G419 — assign laporan ke admin (eksplisit atau auto by beban antrean). ' +
      'Menghitung skor risiko + slaDueAt (24 jam risiko tinggi / 72 jam normal). ' +
      'Assign ulang = handoff (assignment lama ditutup, histori utuh).',
  })
  @ApiResponse({ status: 200, description: 'Showcase report assigned.' })
  @ApiResponse({ status: 400, description: 'Report is not open, or assignee not found.' })
  @ApiResponse({ status: 404, description: 'Showcase report not found.' })
  assignShowcaseReport(
    @Param('reportId', ParseIdPipe) reportId: string,
    @Body() dto: AssignShowcaseReportDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.assignReport(
      reportId,
      dto.assigneeAdminId,
      dto.reasonCode as ModerationReasonCodeValue | undefined,
      admin.sub,
      req.ip ?? '',
    );
  }

  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Post(':reportId/restrict')
  @ApiOperation({
    summary: 'Temporarily restrict a showcase item',
    description:
      'G423 — RESTRICT_TEMPORARY: sembunyikan item selama N hari (auto-restore ' +
      'via scheduler). Berbeda dari TAKEDOWN permanen. Alasan manual wajib (G422). ' +
      'Requires Idempotency-Key.',
  })
  @ApiResponse({ status: 200, description: 'Showcase item restricted.' })
  @ApiResponse({ status: 400, description: 'Report already resolved, item inactive, or reason too short.' })
  @ApiResponse({ status: 404, description: 'Showcase report not found.' })
  restrictShowcase(
    @Param('reportId', ParseIdPipe) reportId: string,
    @Body() dto: RestrictShowcaseDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.restrictShowcase(
      reportId,
      dto.days,
      dto.reason,
      dto.reasonCode as ModerationReasonCodeValue | undefined,
      admin.sub,
      req.ip ?? '',
    );
  }

  @UseGuards(UserThrottleGuard)
  @Post('appeals/:appealId/decide')
  @ApiOperation({
    summary: 'Decide an appeal',
    description:
      'G405/G406/G407/G408/G422 — putusan banding. Reviewer WAJIB berbeda dari ' +
      'moderator keputusan awal (422) dan tidak boleh punya konflik kepentingan ' +
      '(pernah menangani report item/pemilik sama 90 hari terakhir → 422). ' +
      'decisionNote manual wajib. APPROVED → item di-restore (G408).',
  })
  @ApiResponse({ status: 200, description: 'Appeal decided.' })
  @ApiResponse({ status: 404, description: 'Appeal not found.' })
  @ApiResponse({ status: 409, description: 'Appeal already decided.' })
  @ApiResponse({ status: 422, description: 'Reviewer conflict of interest.' })
  decideAppeal(
    @Param('appealId', ParseIdPipe) appealId: string,
    @Body() dto: DecideAppealDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.decideAppeal(appealId, dto.decision, dto.decisionNote, admin.sub, req.ip ?? '');
  }
}
