import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards, Req } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { Request } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminKycService } from './admin-kyc.service';
import { KycQueueQueryDto } from './dto/kyc-queue-query.dto';
import { KycMetricsQueryDto } from './dto/kyc-metrics-query.dto';
import { ReviewKycDto } from './dto/review-kyc.dto';
import { RejectKycDto } from './dto/reject-kyc.dto';
import { RevokeKycDto } from './dto/revoke-kyc.dto';
import { GetDocumentUrlsDto } from './dto/get-document-urls.dto';
import { UpdateSlaConfigDto } from './dto/sla-config.dto';
import { BulkApproveKycDto, BulkRejectKycDto } from './dto/bulk-kyc.dto';
import { AssignReviewerDto } from './dto/assign-reviewer.dto';
import { RequestDocumentsDto } from './dto/request-documents.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

@ApiTags('admin-kyc')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
@AdminRoute()
@Controller('admin/kyc')
export class AdminKycController {
  constructor(private readonly service: AdminKycService) {}

  // ------------------------------------------------------------------
  // Rute statis didaftarkan SEBELUM rute berparameter agar tidak
  // tertangkap pola ':kycId' (mis. 'bulk/approve' tertelan ':kycId/approve').
  // ------------------------------------------------------------------

  @Get()
  @ApiOperation({ summary: 'Get KYC queue', description: 'Paginated KYC request queue ordered FIFO, filterable by status, SLA breach, age range, and assigned reviewer. Each row carries a live SLA view.' })
  @ApiResponse({ status: 200, description: 'KYC queue returned.' })
  getQueue(@Query() query: KycQueueQueryDto): Promise<object> {
    return this.service.getKycQueue(query);
  }

  @Get('sla-config')
  @ApiOperation({ summary: 'Get effective operational SLA config', description: 'Returns effective SLA config per scope (KYC_PERSONAL, BUSINESS_VERIFICATION). Defaults (48 calendar hours) are seeded on first read.' })
  @ApiResponse({ status: 200, description: 'SLA config returned.' })
  getSlaConfig(): Promise<object> {
    return this.service.getSlaConfig();
  }

  @Put('sla-config')
  @ApiOperation({ summary: 'Update operational SLA config', description: 'Updates slaHours/useBusinessHours for a scope. changeReason is mandatory and the change is written to OperationalSlaConfigAudit + admin audit log (SLA_CONFIG_UPDATED).' })
  @ApiResponse({ status: 200, description: 'SLA config updated.' })
  updateSlaConfig(
    @Body() dto: UpdateSlaConfigDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.updateSlaConfig(dto, admin.sub, req.ip || 'unknown');
  }

  @Get('metrics')
  @ApiOperation({ summary: 'KYC review time metrics', description: 'Median/p50/p95 review durations per status within a period (from/to), plus a current queue snapshot. Aggregates only — no NIK or documents.' })
  @ApiResponse({ status: 200, description: 'Metrics returned.' })
  getMetrics(@Query() query: KycMetricsQueryDto): Promise<object> {
    return this.service.getKycMetrics(query.from, query.to);
  }

  @Get('attention')
  @ApiOperation({ summary: 'Attention list', description: 'Items needing attention: SLA breached/warning, document download failures (from audit trail, without opening storage keys), and the old-identity-document recheck queue.' })
  @ApiResponse({ status: 200, description: 'Attention list returned.' })
  getAttention(): Promise<object> {
    return this.service.getAttention();
  }

  @Get('reviewers')
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({
    summary: 'Daftar reviewer KYC (ADM-004)',
    description: 'Daftar admin KYC_ADMIN/SUPER_ADMIN aktif yang bisa ditugaskan sebagai reviewer. Hanya id + nama + role (tanpa email/PII). Boleh dibaca KYC_ADMIN.',
  })
  @ApiResponse({ status: 200, description: 'Reviewer list returned.' })
  listReviewers(): Promise<object> {
    return this.service.listReviewers();
  }

  @Post('bulk/approve')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({ summary: 'Bulk approve KYC requests (max 50)', description: 'Approves multiple pending KYC requests in one call. expectedStatus guards against acting on items whose status changed since the list was loaded.' })
  async bulkApprove(
    @Body() dto: BulkApproveKycDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.bulkApproveKyc(dto.kycIds, admin.sub, dto.notes, req.ip || 'unknown', dto.expectedStatus);
  }

  @Post('bulk/reject')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({ summary: 'Bulk reject KYC requests (max 50)' })
  async bulkReject(
    @Body() dto: BulkRejectKycDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.bulkRejectKyc(dto.kycIds, admin.sub, dto.reason, dto.notes, req.ip || 'unknown', dto.expectedStatus);
  }

  // ------------------------------------------------------------------
  // Rute berparameter ':kycId'.
  // ------------------------------------------------------------------

  @Get(':kycId')
  @ApiOperation({ summary: 'Get KYC detail', description: 'Returns full KYC request detail including submitted documents, live SLA view, assignment history, and masked reviewer notes.' })
  @ApiResponse({ status: 200, description: 'KYC detail returned.' })
  @ApiResponse({ status: 404, description: 'KYC request not found.' })
  getDetail(
    @Param('kycId', ParseIdPipe) kycId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    return this.service.getKycDetail(kycId, admin.sub, req.ip || 'unknown');
  }

  @Post(':kycId/document-urls')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Get short-lived signed URLs for KYC documents', description: 'Decrypts stored document keys and returns 5-minute pre-signed S3 download URLs. Requires re-authentication with admin password. KYC_ADMIN and SUPER_ADMIN only.' })
  @ApiResponse({ status: 200, description: 'Signed URLs returned (expires in 300 s).' })
  @ApiResponse({ status: 401, description: 'Re-authentication failed.' })
  @ApiResponse({ status: 404, description: 'KYC request not found.' })
  getDocumentUrls(
    @Param('kycId', ParseIdPipe) kycId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
    @Body() dto: GetDocumentUrlsDto,
  ): Promise<{ ktpUrl: string | null; selfieUrl: string | null; partialErrors?: string[] }> {
    return this.service.getDocumentUrls(kycId, admin.sub, req.ip || 'unknown', dto.password);
  }

  @Post(':kycId/approve')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({ summary: 'Approve KYC', description: 'Approves a pending KYC request and sets kycApprovedAt on the user. ADMIN and SUPER_ADMIN only.' })
  @ApiResponse({ status: 200, description: 'KYC approved — user kycStatus set to APPROVED and kycApprovedAt set.' })
  @ApiResponse({ status: 400, description: 'KYC is not in PENDING status.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role.' })
  @ApiResponse({ status: 404, description: 'KYC request not found.' })
  approve(
    @Param('kycId', ParseIdPipe) kycId: string,
    @Body() dto: ReviewKycDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    return this.service.approveKyc(kycId, admin.sub, dto.notes, req.ip || 'unknown');
  }

  @Post(':kycId/reject')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({ summary: 'Reject KYC', description: 'Rejects a pending KYC request with a mandatory reason. ADMIN and SUPER_ADMIN only.' })
  @ApiResponse({ status: 200, description: 'KYC is not in PENDING status.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role.' })
  @ApiResponse({ status: 404, description: 'KYC request not found.' })
  reject(
    @Param('kycId', ParseIdPipe) kycId: string,
    @Body() dto: RejectKycDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    return this.service.rejectKyc(kycId, admin.sub, dto.reason, dto.notes, req.ip || 'unknown');
  }

  @Post(':kycId/revoke')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Revoke KYC', description: 'Revokes a previously approved KYC. SUPER_ADMIN only.' })
  @ApiResponse({ status: 200, description: 'KYC revoked.' })
  @ApiResponse({ status: 400, description: 'KYC is not in APPROVED status.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role.' })
  @ApiResponse({ status: 404, description: 'KYC request not found.' })
  revoke(
    @Param('kycId', ParseIdPipe) kycId: string,
    @Body() dto: RevokeKycDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    return this.service.revokeKyc(kycId, admin.sub, dto.reason, req.ip || 'unknown');
  }

  @Post(':kycId/assign')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({ summary: 'Assign a reviewer to a KYC request', description: 'Creates an audited reviewer assignment; any previous active assignment is deactivated (history preserved). Target must be an active KYC_ADMIN or SUPER_ADMIN.' })
  @ApiResponse({ status: 200, description: 'Reviewer assigned.' })
  @ApiResponse({ status: 404, description: 'KYC request or reviewer not found.' })
  assignReviewer(
    @Param('kycId', ParseIdPipe) kycId: string,
    @Body() dto: AssignReviewerDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.assignReviewer(kycId, dto.adminId, admin.sub, req.ip || 'unknown');
  }

  @Delete(':kycId/assign')
  // BAD-030: throttle guard (konsisten dengan POST assign di atas).
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({ summary: 'Release the active reviewer assignment' })
  @ApiResponse({ status: 200, description: 'Assignment released.' })
  @ApiResponse({ status: 404, description: 'No active assignment.' })
  releaseReviewer(
    @Param('kycId', ParseIdPipe) kycId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.releaseReviewer(kycId, admin.sub, req.ip || 'unknown');
  }

  @Post(':kycId/request-documents')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({ summary: 'Request additional documents (pauses SLA)', description: 'Pauses the operational SLA clock for a PENDING request and notifies the user to complete their documents. Resume happens when the user completes documents or via POST :kycId/resume-sla.' })
  @ApiResponse({ status: 200, description: 'SLA paused; user notified.' })
  @ApiResponse({ status: 400, description: 'Request is not PENDING or SLA already paused.' })
  requestDocuments(
    @Param('kycId', ParseIdPipe) kycId: string,
    @Body() dto: RequestDocumentsDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.requestDocuments(kycId, admin.sub, dto.message, dto.notes, req.ip || 'unknown');
  }

  @Post(':kycId/resume-sla')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({ summary: 'Resume a paused SLA clock', description: 'Accumulates the paused interval (in SLA-clock units) and resumes the clock. Prefer the user-side completion endpoint when documents arrive through the app.' })
  @ApiResponse({ status: 200, description: 'SLA resumed.' })
  @ApiResponse({ status: 400, description: 'SLA is not paused.' })
  resumeSla(
    @Param('kycId', ParseIdPipe) kycId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.resumeSla(kycId, admin.sub, req.ip || 'unknown');
  }
}
