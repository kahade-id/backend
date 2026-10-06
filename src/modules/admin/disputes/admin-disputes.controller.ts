import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import { Controller, Get, Post, Param, Body, Query, UseGuards, Req, DefaultValuePipe, ParseBoolPipe, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ParseQueryStringPipe } from '../../../common/pipes/parse-query-string.pipe';
import { ClampLimitPipe } from '../../../common/pipes/clamp-limit.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiConsumes } from '@nestjs/swagger';
import { SubmitEvidenceDto } from '../../disputes/dto/submit-evidence.dto';
import { SubmitDisputeEvidenceAdminDto } from './dto/submit-dispute-evidence-admin.dto';
import { UPLOAD_DIRECT_MULTER_MAX_BYTES } from '../../../common/constants/app.constants';
import { Request } from 'express';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { AdminDisputesService } from './admin-disputes.service';
import { DisputeDecisionDto } from './dispute-decision.dto';
import { ResolvePreviewQueryDto } from './dto/resolve-preview-query.dto';
import { DisputeListQueryDto } from './dto/dispute-list-query.dto';
import { AssignDisputeDto } from './dto/assign-dispute.dto';
import { SendDisputeMessageDto } from './dto/send-dispute-message.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { StepUpGuard } from '../../../common/guards/step-up.guard';
import { RequireStepUp } from '../../../common/decorators/require-step-up.decorator';

@ApiTags('admin-disputes')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN', 'DISPUTE_ADMIN')
@AdminRoute()
@Controller('admin/disputes')
export class AdminDisputesController {
  constructor(private readonly service: AdminDisputesService) {}

  @Get()
  @ApiOperation({ summary: 'List disputes', description: 'Paginated list of all disputes with optional status filter.' })
  @ApiResponse({ status: 200, description: 'Disputes list returned.' })
  listDisputes(@Query() query: DisputeListQueryDto): Promise<object> {
    return this.service.listDisputes(query.page!, query.limit!, query.status, query.search, query.category, query.unassigned);
  }

  @Get(':disputeId')
  @ApiOperation({ summary: 'Get dispute detail', description: 'Returns full dispute detail including order, evidence, and decision.' })
  @ApiResponse({ status: 200, description: 'Dispute detail returned.' })
  @ApiResponse({ status: 404, description: 'Dispute not found.' })
  getDetail(@Param('disputeId', ParseIdPipe) disputeId: string, @CurrentAdmin() admin: AdminJwtPayload, @Req() req: Request): Promise<object> {
    return this.service.getDisputeDetail(disputeId, admin.sub, req.ip || 'unknown', admin.role);
  }

  @Get(':disputeId/messages')
  @AdminRoles('SUPER_ADMIN', 'DISPUTE_ADMIN')
  @ApiOperation({ summary: 'Get order chat messages for a dispute', description: 'Returns paginated chat messages from the order linked to the dispute. Only the assigned admin or SUPER_ADMIN can access.' })
  @ApiResponse({ status: 200, description: 'Messages returned.' })
  @ApiResponse({ status: 403, description: 'Not the assigned admin.' })
  @ApiResponse({ status: 404, description: 'Dispute not found.' })
  getDisputeMessages(
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Query('cursor', new ParseQueryStringPipe('cursor', 50)) cursor?: string,
    @Query('limit', new DefaultValuePipe(50), new ClampLimitPipe(100)) limit?: number,
  ): Promise<object> {
    return this.service.getDisputeMessages(disputeId, admin.sub, cursor, limit ?? 50);
  }

  @Get(':disputeId/chat')
  @AdminRoles('SUPER_ADMIN', 'DISPUTE_ADMIN')
  @ApiOperation({
    summary: 'Get order chat messages for a dispute, including deleted ones',
    description:
      'Returns the buyer-seller conversation attached to the disputed order. Soft-deleted messages are included with their original content in `deletedContent`, because that content is evidence. Only the assigned admin or SUPER_ADMIN can access.',
  })
  @ApiResponse({ status: 200, description: 'Chat messages returned.' })
  @ApiResponse({ status: 403, description: 'Not the assigned admin.' })
  @ApiResponse({ status: 404, description: 'Dispute not found.' })
  getDisputeChat(
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Query('cursor', new ParseQueryStringPipe('cursor', 50)) cursor?: string,
    @Query('limit', new DefaultValuePipe(50), new ClampLimitPipe(100)) limit?: number,
    @Query('includeDeleted', new DefaultValuePipe(true), ParseBoolPipe) includeDeleted?: boolean,
    @Req() req?: Request,
  ): Promise<object> {
    return this.service.getDisputeOrderChat(disputeId, admin.sub, cursor, limit ?? 50, includeDeleted !== false, req?.ip || 'unknown');
  }

  @Post(':disputeId/messages')
  @Idempotency()
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'DISPUTE_ADMIN')
  @ApiOperation({ summary: 'Send a message to the dispute order chat', description: 'Allows the assigned admin or SUPER_ADMIN to send a message into the dispute order chat as a SYSTEM message.' })
  @ApiResponse({ status: 201, description: 'Message sent.' })
  @ApiResponse({ status: 403, description: 'Not the assigned admin.' })
  @ApiResponse({ status: 404, description: 'Dispute not found.' })
  sendDisputeMessage(
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Body() dto: SendDisputeMessageDto,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.sendDisputeMessage(disputeId, admin.sub, dto.content, req.ip || 'unknown');
  }

  // BAI-094: admin melampirkan bukti "titipan" ke sengketa. Dua tahap:
  // 1) POST :disputeId/evidence/upload (multipart) → fileKey (belum di-confirm)
  // 2) POST :disputeId/evidence (JSON SubmitEvidenceDto) → verifikasi +
  //    simpan sebagai bukti ADMIN. Hanya mediator yang di-assign / SUPER_ADMIN.
  @Post(':disputeId/evidence/upload')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'DISPUTE_ADMIN')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: UPLOAD_DIRECT_MULTER_MAX_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Admin upload dispute evidence file', description: 'Uploads a file as admin for later evidence submit. Uses UploadService.uploadDirect with DISPUTE_EVIDENCE purpose (admin-scoped prefix).' })
  @ApiResponse({ status: 201, description: 'File uploaded, returns fileKey.' })
  @ApiResponse({ status: 403, description: 'Not the assigned admin.' })
  uploadEvidenceFile(
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.uploadEvidenceFileAsAdmin(disputeId, admin.sub, file, req.ip || 'unknown');
  }

  @Post(':disputeId/evidence')
  @Idempotency()
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'DISPUTE_ADMIN')
  @ApiOperation({ summary: 'Admin submit dispute evidence', description: 'Submits admin-uploaded files as dispute evidence (submittedByRole=ADMIN). Only the assigned mediator or SUPER_ADMIN.' })
  @ApiResponse({ status: 201, description: 'Evidence submitted.' })
  @ApiResponse({ status: 403, description: 'Not the assigned admin.' })
  submitEvidence(
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Body() dto: SubmitDisputeEvidenceAdminDto,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.submitEvidenceAsAdmin(disputeId, admin.sub, dto, req.ip || 'unknown');
  }

  // BAI-095: catatan internal sengketa (kolaboratif antar admin) —
  // pengganti draf localStorage per-perangkat di panel admin.
  @Get(':disputeId/notes')
  @AdminRoles('SUPER_ADMIN', 'DISPUTE_ADMIN')
  @ApiOperation({ summary: 'List internal dispute notes', description: 'Returns internal notes for a dispute. Only the assigned mediator or SUPER_ADMIN.' })
  listInternalNotes(
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.service.listInternalNotes(disputeId, admin.sub);
  }

  @Post(':disputeId/notes')
  @Idempotency()
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'DISPUTE_ADMIN')
  @ApiOperation({ summary: 'Add internal dispute note', description: 'Adds an internal note to a dispute. Only the assigned mediator or SUPER_ADMIN.' })
  @ApiResponse({ status: 201, description: 'Note added.' })
  addInternalNote(
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Body() body: { note: string },
    @Req() req: Request,
  ): Promise<object> {
    return this.service.addInternalNote(disputeId, admin.sub, body.note, req.ip || 'unknown');
  }

  // B-31 (audit-fix): assign is idempotent so double-click cannot race two
  // admins into the same dispute. Service-side already does an OCC check, but
  // idempotency dedupes the same operator's retry.
  @Post(':disputeId/assign')
  @Idempotency()
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'DISPUTE_ADMIN')
  @ApiOperation({ summary: 'Assign admin to dispute', description: 'Assigns an admin to a dispute. DISPUTE_ADMIN role: self-assignment only. SUPER_ADMIN role: can assign any admin by providing adminId in the body. Requires Idempotency-Key.' })
  @ApiResponse({ status: 200, description: 'Admin assigned, dispute status set to ASSIGNED.' })
  @ApiResponse({ status: 404, description: 'Dispute not found.' })
  assignAdmin(@Param('disputeId', ParseIdPipe) disputeId: string, @CurrentAdmin() admin: AdminJwtPayload, @Body() dto: AssignDisputeDto, @Req() req: Request): Promise<object> {
    return this.service.assignAdmin(disputeId, admin.sub, dto.adminId, req.ip || 'unknown');
  }

  @Post(':disputeId/under-review')
  @Idempotency()
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'DISPUTE_ADMIN')
  @ApiOperation({ summary: 'Begin active review', description: 'Transitions dispute from ASSIGNED to UNDER_REVIEW. Required before resolving.' })
  @ApiResponse({ status: 201, description: 'Dispute status set to UNDER_REVIEW.' })
  @ApiResponse({ status: 400, description: 'Dispute is not in ASSIGNED status or admin is not the assigned admin.' })
  @ApiResponse({ status: 404, description: 'Dispute not found.' })
  markUnderReview(@Param('disputeId', ParseIdPipe) disputeId: string, @CurrentAdmin() admin: AdminJwtPayload, @Req() req: Request): Promise<object> {
    return this.service.markUnderReview(disputeId, admin.sub, req.ip || 'unknown');
  }

  // ADM-109 (audit-fix): pratinjau nominal read-only SEBELUM eksekusi resolve.
  // GET tanpa mutasi sehingga tidak perlu Idempotency-Key; guard status sama
  // dengan resolve agar angka yang ditampilkan pasti bisa dieksekusi.
  @Get(':disputeId/resolve/preview')
  @AdminRoles('SUPER_ADMIN', 'DISPUTE_ADMIN')
  @ApiOperation({ summary: 'Preview disbursement amounts before resolving', description: 'ADM-109: returns buyer/seller/platform amounts for a proposed decision without mutating anything. Dispute must be in UNDER_REVIEW or ESCALATED status.' })
  @ApiResponse({ status: 200, description: 'Preview returned.' })
  @ApiResponse({ status: 400, description: 'Invalid status or split percentages do not sum to 100.' })
  @ApiResponse({ status: 404, description: 'Dispute not found.' })
  previewResolve(
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @Query() query: ResolvePreviewQueryDto,
  ): Promise<object> {
    return this.service.previewResolveDispute(disputeId, query);
  }

  // B-32 (audit-fix): resolve mutates wallet balances and MUST be idempotent
  // -- a network-retry / stale React-Query cache must not double-credit.
  // SEC-501/503: wajib step-up server-side; nominal escrow > Rp1jt → dual
  // control (403 DUAL_CONTROL_REQUIRED — usulkan via /v1/admin/approvals/propose).
  @Post(':disputeId/resolve')
  @Idempotency()
  @UseGuards(UserThrottleGuard, StepUpGuard)
  @RequireStepUp('dispute.resolve', 'disputeId')
  @AdminRoles('SUPER_ADMIN', 'DISPUTE_ADMIN')
  @ApiOperation({ summary: 'Resolve dispute', description: 'Creates a DisputeDecision record with FULL_BUYER, FULL_SELLER, or SPLIT decision type. Dispute must be in UNDER_REVIEW or ESCALATED status. Requires Idempotency-Key. SEC-501/503: requires X-Step-Up-Token (action dispute.resolve); escrow > Rp1.000.000 requires dual control via POST /v1/admin/approvals/propose.' })
  @ApiResponse({ status: 201, description: 'Dispute resolved — DecisionRecord created and order status updated to COMPLETED.' })
  @ApiResponse({ status: 400, description: 'Invalid status or split percentages do not sum to 100.' })
  @ApiResponse({ status: 404, description: 'Dispute not found.' })
  resolve(
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @Body() dto: DisputeDecisionDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.resolveDispute(disputeId, admin.sub, dto, req.ip || 'unknown');
  }
}
