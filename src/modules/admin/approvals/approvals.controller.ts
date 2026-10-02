import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminRoute } from '../../../common/decorators/public.decorator';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { Throttle } from '@nestjs/throttler';
import { AdminStepUpService } from '../auth/step-up.service';
import { ApprovalsService } from './approvals.service';
import {
  APPROVAL_ACTION_ROLES,
  ProposeApprovalDto,
  RejectApprovalDto,
} from './dto/approval.dto';
import { APPROVAL_STEP_UP_ACTIONS } from './dual-control.constants';
import { AdminRole } from '@prisma/client';

/**
 * SEC-501/502/601/602 + BAD-001 (audit 2026-10-03): dual control
 * (maker-checker) untuk aksi admin sensitif.
 *
 * propose & approve WAJIB step-up: token diterbitkan via
 * POST /v1/admin/auth/step-up dengan `action` = pemetaan di
 * APPROVAL_STEP_UP_ACTIONS untuk tipe aksi yang diusulkan/disetujui
 * (mis. 'dispute.resolve'), dikirim via header X-Step-Up-Token.
 * approve oleh pengusul sendiri → 403 SELF_APPROVAL.
 */
@ApiTags('admin-approvals')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(
  AdminRole.SUPER_ADMIN,
  AdminRole.DISPUTE_ADMIN,
  AdminRole.FINANCE_ADMIN,
)
@AdminRoute()
@Controller('admin/approvals')
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly stepUp: AdminStepUpService,
  ) {}

  private stepUpTokenFrom(req: Request): string | undefined {
    const raw = req.headers['x-step-up-token'];
    const token = Array.isArray(raw) ? raw[0] : raw;
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  }

  @Post('propose')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Usulkan aksi sensitif (butuh persetujuan admin kedua)',
    description:
      'Wajib step-up: X-Step-Up-Token harus diterbitkan untuk action yang ' +
      'dipetakan dari actionType (lihat APPROVAL_STEP_UP_ACTIONS). Idempoten ' +
      'per idempotencyKey — propose ulang mengembalikan record yang ada.',
  })
  @ApiResponse({ status: 200, description: 'Approval PENDING dibuat (atau dikembalikan bila idempoten).' })
  @ApiResponse({ status: 403, description: 'STEP_UP_* / role tidak berhak atas tipe aksi.' })
  async propose(
    @Body() dto: ProposeApprovalDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ) {
    const stepUpAction = APPROVAL_STEP_UP_ACTIONS[dto.actionType];
    await this.stepUp.consumeStepUpToken(this.stepUpTokenFrom(req), {
      adminId: admin.sub,
      action: stepUpAction,
      targetId: dto.targetId,
    });
    const view = await this.approvals.propose({
      actionType: dto.actionType,
      targetId: dto.targetId,
      payload: dto.payload,
      amountSen: dto.amountSen,
      idempotencyKey: dto.idempotencyKey,
      proposedBy: admin.sub,
      proposerRole: admin.role,
      ipAddress: req.ip || 'unknown',
    });
    return view;
  }

  @Post(':id/approve')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Setujui + eksekusi usulan (admin kedua)',
    description:
      'Wajib step-up milik approver (action = pemetaan tipe aksi approval ' +
      'ini). Pengusul tidak boleh menyetujui sendiri → 403 SELF_APPROVAL.',
  })
  @ApiResponse({ status: 200, description: 'Approval EXECUTED.' })
  @ApiResponse({ status: 403, description: 'SELF_APPROVAL / STEP_UP_*.' })
  @ApiResponse({ status: 404, description: 'Approval tidak ditemukan.' })
  async approve(
    @Param('id') id: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ) {
    const existing = await this.approvals.getByIdOrThrow(id);
    const stepUpAction = APPROVAL_STEP_UP_ACTIONS[existing.actionType];
    await this.stepUp.consumeStepUpToken(this.stepUpTokenFrom(req), {
      adminId: admin.sub,
      action: stepUpAction,
      targetId: existing.targetId ?? undefined,
    });
    const view = await this.approvals.approve(id, admin.sub, admin.role, req.ip || 'unknown');
    return view;
  }

  @Post(':id/reject')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Tolak usulan (dengan alasan opsional, teraudit)',
    description:
      'Pengusul boleh membatalkan usulannya sendiri; selain itu hanya role ' +
      'yang berhak atas tipe aksi ini.',
  })
  @ApiResponse({ status: 200, description: 'Approval REJECTED.' })
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectApprovalDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ) {
    return this.approvals.reject(id, admin.sub, admin.role, dto.reason, req.ip || 'unknown');
  }

  @Get('pending')
  @ApiOperation({ summary: 'Daftar usulan menunggu persetujuan' })
  @ApiResponse({ status: 200, description: 'Daftar PENDING (yang kedaluwarsa ditandai EXPIRED).' })
  async pending() {
    return { approvals: await this.approvals.listPending() };
  }
}
