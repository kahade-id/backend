import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Patch, Param, Query, Body, UseGuards, Req } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminInsuranceClaimsService } from './admin-insurance-claims.service';
import { AdminInsuranceClaimQueryDto, ReviewInsuranceClaimDto } from './dto/admin-insurance-claim.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRole } from '@prisma/client';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { Request } from 'express';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { StepUpGuard } from '../../../common/guards/step-up.guard';
import { RequireStepUp } from '../../../common/decorators/require-step-up.decorator';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';

@ApiTags('admin-insurance-claims')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.FINANCE_ADMIN, AdminRole.CUSTOMER_SUPPORT)
@AdminRoute()
@Controller('admin/insurance-claims')
export class AdminInsuranceClaimsController {
  constructor(private readonly service: AdminInsuranceClaimsService) {}

  @Get()
  @ApiOperation({ summary: 'Daftar klaim asuransi Kahade+ (paginated, filter status)' })
  @ApiResponse({ status: 200, description: 'Daftar klaim dikembalikan.' })
  listClaims(@Query() query: AdminInsuranceClaimQueryDto): Promise<object> {
    return this.service.listClaims(query.page ?? 1, query.limit ?? 20, query.status, query.search);
  }

  @Patch(':claimId')
  @Idempotency()
  @UseGuards(UserThrottleGuard, StepUpGuard)
  // SEC-502/503: review klaim (APPROVED/REJECTED/PAID) wajib step-up
  // server-side. PAID SELALU via dual control — endpoint hanya membuat
  // usulan PENDING, eksekusi oleh admin kedua via /v1/admin/approvals/:id/approve.
  @RequireStepUp('insurance.review', 'claimId')
  // ADM-208: reviewClaim (termasuk transisi PAID yang mengeksekusi payout
  // nyata ke wallet) HANYA untuk role keuangan. Class-level mengizinkan
  // CUSTOMER_SUPPORT untuk list (read/triage); method-level ini menimpa
  // (getAllAndOverride: handler didahulukan) sehingga CS mendapat 403.
  @AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.FINANCE_ADMIN)
  @ApiOperation({ summary: 'Ubah status klaim asuransi (APPROVED/REJECTED/PAID)', description: 'ADM-208: hanya SUPER_ADMIN / FINANCE_ADMIN. SEC-502/503: wajib X-Step-Up-Token (action insurance.review). Transisi PAID selalu via dual control (mengembalikan approvalId PENDING; payout dieksekusi admin kedua).' })
  @ApiResponse({ status: 200, description: 'Status klaim diperbarui / usulan pembayaran dibuat.' })
  @ApiResponse({ status: 403, description: 'Role tidak diizinkan (CS tidak boleh me-review klaim).' })
  @ApiResponse({ status: 404, description: 'Klaim tidak ditemukan.' })
  reviewClaim(
    @Param('claimId', ParseIdPipe) claimId: string,
    @Body() dto: ReviewInsuranceClaimDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.reviewClaim(claimId, dto.status, dto.note, admin.sub, admin.role, req.ip ?? '');
  }
}
