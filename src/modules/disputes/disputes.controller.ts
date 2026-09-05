import { Controller, Get, Post, Delete, Body, Param, Query, UseGuards, HttpCode } from '@nestjs/common';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, IsNotEmpty, MaxLength, IsOptional, IsArray, ArrayMaxSize, ValidateNested, IsNumber, Min, Max, IsInt, IsIn, Matches } from 'class-validator';
import { Type } from 'class-transformer';
import { DisputeEvidence } from '@prisma/client';
import { DisputesService } from './disputes.service';
import { DisputeMessageService } from './dispute-message.service';
import { DisputeCallService } from './dispute-call.service';
import { MutualResolutionService } from './mutual-resolution.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotency } from '../../common/decorators/idempotency.decorator';
import { PaginationDto, PaginatedResponse } from '../../common/dto/pagination.dto';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { SubmitEvidenceDto, ALLOWED_EVIDENCE_MIME_TYPES } from './dto/submit-evidence.dto';
import { SubmitClaimDto } from './dto/submit-claim.dto';

class DisputeMessageAttachmentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  @Matches(/^[^\u0000-\u001f]+$/)
  fileKey!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(/^[^\\/\u0000-\u001f]+$/)
  fileName!: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(ALLOWED_EVIDENCE_MIME_TYPES)
  @MaxLength(100)
  fileType!: string;

  @IsNumber()
  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024)
  fileSize!: number;
}

export class DisputeMessageDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  message?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => DisputeMessageAttachmentDto)
  attachments?: DisputeMessageAttachmentDto[];
}

export class CallActionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  callId!: string;
}

export class MutualResolutionProposeDto {
  @IsInt()
  @Min(0)
  @Max(100)
  buyerPercent!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  sellerPercent!: number;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'Reason must contain at least one non-whitespace character' })
  @MaxLength(2000)
  reason!: string;
}

export class MutualResolutionRespondDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['ACCEPT', 'REJECT'])
  action!: 'ACCEPT' | 'REJECT';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  responseNote?: string;
}

@ApiTags('disputes')
@ApiBearerAuth('access-token')
@Controller('disputes')
export class DisputesController {
  constructor(
    private disputesService: DisputesService,
    private disputeMessageService: DisputeMessageService,
    private disputeCallService: DisputeCallService,
    private mutualResolutionService: MutualResolutionService,
  ) {}

  @Get('my')
  @ApiOperation({ summary: 'List my disputes' })
  async listMyDisputes(
    @CurrentUser('sub') userId: string,
    @Query() pagination: PaginationDto,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.disputesService.listMyDisputes(userId, pagination.page!, pagination.limit!);
  }

  @Get(':disputeId')
  @ApiOperation({ summary: 'Get dispute detail' })
  async getDisputeDetail(
    @CurrentUser('sub') userId: string,
    @Param('disputeId', ParseIdPipe) disputeId: string,
  ): Promise<Record<string, unknown>> {
    return this.disputesService.getDisputeDetail(disputeId, userId);
  }

  @Get(':disputeId/evidence')
  @ApiOperation({ summary: 'List dispute evidence with pagination' })
  async listEvidence(
    @CurrentUser('sub') userId: string,
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @Query() pagination: PaginationDto,
  ): Promise<PaginatedResponse<DisputeEvidence>> {
    return this.disputesService.listEvidence(disputeId, userId, pagination.page ?? 1, pagination.limit ?? 20);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 10 } })
  @Idempotency()
  @Post(':disputeId/evidence')
  @ApiOperation({ summary: 'Submit dispute evidence (batch, per-file validation)' })
  async submitEvidence(
    @CurrentUser('sub') userId: string,
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @Body() dto: SubmitEvidenceDto,
  ): Promise<{
    evidence: DisputeEvidence | null;
    fileResults: { fileKey: string; fileType: string; status: string; error?: string }[];
    summary: { total: number; succeeded: number; failed: number };
  }> {
    return this.disputesService.submitEvidence(disputeId, userId, dto);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 10 } })
  @Idempotency()
  @Delete(':disputeId/evidence/:evidenceId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete own dispute evidence' })
  async deleteEvidence(
    @CurrentUser('sub') userId: string,
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @Param('evidenceId', ParseIdPipe) evidenceId: string,
  ): Promise<{ deleted: boolean }> {
    return this.disputesService.deleteEvidence(disputeId, evidenceId, userId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @Idempotency()
  @Post(':disputeId/claim')
  @ApiOperation({ summary: 'Submit or update claim text' })
  async submitClaim(
    @CurrentUser('sub') userId: string,
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @Body() dto: SubmitClaimDto,
  ): Promise<Record<string, unknown>> {
    return this.disputesService.submitClaim(disputeId, userId, dto);
  }

  @Get(':disputeId/messages')
  @ApiOperation({ summary: 'Get dispute messages' })
  async getDisputeMessages(
    @CurrentUser('sub') userId: string,
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @Query() pagination: PaginationDto,
  ): Promise<object> {
    return this.disputeMessageService.getMessages(disputeId, userId, pagination.page ?? 1, pagination.limit ?? 50);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Idempotency()
  @Post(':disputeId/messages')
  @ApiOperation({ summary: 'Send a dispute message' })
  async sendDisputeMessage(
    @CurrentUser('sub') userId: string,
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @Body() dto: DisputeMessageDto,
  ): Promise<object> {
    return this.disputeMessageService.sendMessage(disputeId, userId, dto.message || '', dto.attachments);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Idempotency()
  @Post(':disputeId/call/request')
  @ApiOperation({ summary: 'Request a video call in a dispute' })
  async requestCall(
    @CurrentUser('sub') userId: string,
    @Param('disputeId', ParseIdPipe) disputeId: string,
  ): Promise<object> {
    return this.disputeCallService.requestCall(disputeId, userId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Idempotency()
  @Post(':disputeId/call/accept')
  @ApiOperation({ summary: 'Accept a video call request' })
  async acceptCall(
    @CurrentUser('sub') userId: string,
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @Body() dto: CallActionDto,
  ): Promise<object> {
    return this.disputeCallService.acceptCall(disputeId, userId, dto.callId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Idempotency()
  @Post(':disputeId/call/reject')
  @ApiOperation({ summary: 'Reject a video call request' })
  async rejectCall(
    @CurrentUser('sub') userId: string,
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @Body() dto: CallActionDto,
  ): Promise<object> {
    return this.disputeCallService.rejectCall(disputeId, userId, dto.callId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Idempotency()
  @Post(':disputeId/call/end')
  @ApiOperation({ summary: 'End an active video call' })
  async endCall(
    @CurrentUser('sub') userId: string,
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @Body() dto: CallActionDto,
  ): Promise<object> {
    return this.disputeCallService.endCall(disputeId, userId, dto.callId);
  }

  @Get(':disputeId/calls')
  @ApiOperation({ summary: 'Get call history for a dispute' })
  async getCallHistory(
    @CurrentUser('sub') userId: string,
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @Query() pagination: PaginationDto,
  ): Promise<object> {
    return this.disputeCallService.getCallHistory(disputeId, userId, pagination.page ?? 1, pagination.limit ?? 20);
  }

  @Get(':disputeId/mutual-resolution')
  @ApiOperation({ summary: 'Get mutual resolution proposals' })
  async getMutualResolutionProposals(
    @CurrentUser('sub') userId: string,
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @Query() pagination: PaginationDto,
  ): Promise<object> {
    return this.mutualResolutionService.getProposals(disputeId, userId, pagination.page ?? 1, pagination.limit ?? 20);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 10 } })
  @Idempotency()
  @Post(':disputeId/mutual-resolution')
  @ApiOperation({ summary: 'Propose a mutual resolution' })
  async proposeMutualResolution(
    @CurrentUser('sub') userId: string,
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @Body() dto: MutualResolutionProposeDto,
  ): Promise<object> {
    return this.mutualResolutionService.propose(disputeId, userId, dto);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 10 } })
  @Idempotency()
  @Post(':disputeId/mutual-resolution/:proposalId/respond')
  @ApiOperation({ summary: 'Accept or reject a mutual resolution proposal' })
  async respondMutualResolution(
    @CurrentUser('sub') userId: string,
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @Param('proposalId', ParseIdPipe) proposalId: string,
    @Body() dto: MutualResolutionRespondDto,
  ): Promise<object> {
    return this.mutualResolutionService.respond(disputeId, proposalId, userId, dto.action, dto.responseNote);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 10 } })
  @Idempotency()
  @Delete(':disputeId/mutual-resolution/:proposalId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Withdraw own pending proposal' })
  async withdrawMutualResolution(
    @CurrentUser('sub') userId: string,
    @Param('disputeId', ParseIdPipe) disputeId: string,
    @Param('proposalId', ParseIdPipe) proposalId: string,
  ): Promise<{ status: string }> {
    return this.mutualResolutionService.withdraw(disputeId, proposalId, userId);
  }
}
