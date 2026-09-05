import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import { Controller, Get, Post, Param, Body, Query, UseGuards, Req, DefaultValuePipe } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ParseQueryStringPipe } from '../../../common/pipes/parse-query-string.pipe';
import { ClampLimitPipe } from '../../../common/pipes/clamp-limit.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { AdminDisputesService } from './admin-disputes.service';
import { DisputeDecisionDto } from './dispute-decision.dto';
import { DisputeListQueryDto } from './dto/dispute-list-query.dto';
import { AssignDisputeDto } from './dto/assign-dispute.dto';
import { SendDisputeMessageDto } from './dto/send-dispute-message.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

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
    return this.service.listDisputes(query.page!, query.limit!, query.status, query.search);
  }

  @Get(':disputeId')
  @ApiOperation({ summary: 'Get dispute detail', description: 'Returns full dispute detail including order, evidence, and decision.' })
  @ApiResponse({ status: 200, description: 'Dispute detail returned.' })
  @ApiResponse({ status: 404, description: 'Dispute not found.' })
  getDetail(@Param('disputeId', ParseIdPipe) disputeId: string, @CurrentAdmin() admin: AdminJwtPayload, @Req() req: Request): Promise<object> {
    return this.service.getDisputeDetail(disputeId, admin.sub, req.ip || 'unknown');
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

  // B-32 (audit-fix): resolve mutates wallet balances and MUST be idempotent
  // -- a network-retry / stale React-Query cache must not double-credit.
  @Post(':disputeId/resolve')
  @Idempotency()
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'DISPUTE_ADMIN')
  @ApiOperation({ summary: 'Resolve dispute', description: 'Creates a DisputeDecision record with FULL_BUYER, FULL_SELLER, or SPLIT decision type. Dispute must be in UNDER_REVIEW or ESCALATED status. Requires Idempotency-Key.' })
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
