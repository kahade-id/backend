import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { AdminDisbursementService } from './admin-disbursement.service';
import { DisbursementQueryDto, DisbursementReviewDto } from './dto/disbursement.dto';
import { AdminActionReasonDto } from '../management/dto/admin-action-reason.dto';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { StepUpGuard } from '../../../common/guards/step-up.guard';
import { RequireStepUp } from '../../../common/decorators/require-step-up.decorator';

/**
 * BAI-043 (P0) — antrean admin READ-ONLY untuk lifecycle EscrowDisbursement
 * DANA (satu-satunya sumber kebenaran pencairan dana era tanpa-wallet).
 *
 * Prinsip keamanan uang (fail-closed):
 * - List & detail: murni baca.
 * - `recheck`: query status ke DANA (read terhadap provider) + transisi yang
 *   SAMA dengan cron otomatis — TIDAK PERNAH mengirim transfer baru.
 * - `review` (NEEDS_REVIEW → RETRY/CANCEL): SUPER_ADMIN only, step-up wajib
 *   (SYS-B-401), reason min 10, audit trail wajib. RETRY → PENDING → cron.
 * - `review` dengan keputusan FORCE_SUCCESS: SELALU via dual control
 *   (SYS-B-401, actionType DISBURSEMENT_FORCE_SUCCESS) — endpoint hanya
 *   membuat usulan PENDING; eksekusi (SUCCESS) oleh admin kedua via
 *   POST /v1/admin/approvals/:id/approve. Bukti transfer nyata wajib di reason.
 * - `requeue` (HELD_NO_BANK → PENDING): hanya mengubah status lokal agar cron
 *   retryDue memproses ulang via settle() yang fail-closed (inquiry bank +
 *   verifikasi nama tetap dijalankan).
 */
@ApiTags('admin-finance-disbursements')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('FINANCE_ADMIN', 'SUPER_ADMIN')
@AdminRoute()
@Controller('admin/finance/disbursements')
export class AdminDisbursementController {
  constructor(private readonly service: AdminDisbursementService) {}

  @Get()
  @ApiOperation({
    summary: 'Antrean disbursement DANA (read-only)',
    description:
      'BAI-043: daftar EscrowDisbursement (escrow order, milestone, cashback, referral, dispute release, legacy payout) dengan filter status & scope. Murni baca — tidak ada eksekusi uang.',
  })
  @ApiResponse({ status: 200, description: 'Daftar disbursement (paginated).' })
  listDisbursements(@Query() query: DisbursementQueryDto): Promise<object> {
    return this.service.listDisbursements(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detail disbursement DANA',
    description:
      'BAI-043: detail satu disbursement (termasuk rekening bank ter-masking, heldReason, lastError). Aksi view tercatat di audit trail.',
  })
  @ApiResponse({ status: 200, description: 'Detail disbursement.' })
  @ApiResponse({ status: 404, description: 'Disbursement tidak ditemukan.' })
  getDisbursement(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.getDisbursement(id, adminId, req.ip || 'unknown');
  }

  @Post(':id/recheck')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Recheck status disbursement ke DANA',
    description:
      'BAI-042 (arahan DANA): query SATU disbursement PROCESSING ke DANA Transfer-to-Bank Status API lalu terapkan transisi aman yang sama dengan cron otomatis (SUCCESS → SUCCESS, FAILED/EXPIRED → FAILED; ambigu → tetap PROCESSING). TIDAK PERNAH mengirim transfer baru. Requires Idempotency-Key.',
  })
  @ApiResponse({ status: 200, description: 'Hasil recheck (providerStatus + outcome).' })
  @ApiResponse({ status: 404, description: 'Disbursement tidak ditemukan.' })
  @ApiResponse({ status: 409, description: 'Disbursement bukan PROCESSING.' })
  recheckDisbursement(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.recheckDisbursement(id, adminId, req.ip || 'unknown');
  }

  @Post(':id/review')
  @AdminRoles('SUPER_ADMIN')
  @UseGuards(UserThrottleGuard, StepUpGuard)
  // SYS-B-401: review manual NEEDS_REVIEW wajib step-up server-side
  // (keputusan RETRY memicu transfer DANA nyata via cron).
  @RequireStepUp('disbursement.review', 'id')
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Review manual baris NEEDS_REVIEW (SUPER_ADMIN)',
    description:
      'BAI-044 + SYS-B-401: putuskan baris NEEDS_REVIEW — RETRY (kembali PENDING, diproses cron secara idempoten), CANCEL (terminal), atau FORCE_SUCCESS (SELALU via dual control: endpoint ini hanya membuat usulan, eksekusi oleh admin kedua via POST /v1/admin/approvals/:id/approve). Audit trail wajib. Requires X-Step-Up-Token (action disbursement.review) + Idempotency-Key.',
  })
  @ApiResponse({ status: 200, description: 'Keputusan review tercatat.' })
  @ApiResponse({ status: 404, description: 'Disbursement tidak ditemukan.' })
  @ApiResponse({ status: 409, description: 'Disbursement bukan NEEDS_REVIEW.' })
  reviewDisbursement(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: DisbursementReviewDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.reviewDisbursement(id, dto, admin.sub, admin.role, req.ip || 'unknown');
  }

  @Post(':id/requeue')
  @AdminRoles('SUPER_ADMIN', 'FINANCE_ADMIN')
  @UseGuards(UserThrottleGuard, StepUpGuard)
  // SYS-B-401: requeue HELD_NO_BANK → PENDING wajib step-up server-side
  // (membuka jalan ke transfer DANA nyata via cron retryDue).
  @RequireStepUp('disbursement.requeue', 'id')
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Cairkan ulang baris HELD_NO_BANK',
    description:
      'BAI-045 + SYS-B-401: kembalikan baris HELD_NO_BANK ke PENDING setelah seller mendaftarkan rekening terverifikasi; cron retryDue memprosesnya via settle() (inquiry bank + verifikasi nama tetap dijalankan — fail-closed bila rekening belum valid). Requires X-Step-Up-Token (action disbursement.requeue) + Idempotency-Key.',
  })
  @ApiResponse({ status: 200, description: 'Disbursement dikembalikan ke PENDING.' })
  @ApiResponse({ status: 404, description: 'Disbursement tidak ditemukan.' })
  @ApiResponse({ status: 409, description: 'Disbursement bukan HELD_NO_BANK.' })
  requeueDisbursement(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.requeueDisbursement(id, adminId, req.ip || 'unknown');
  }

  @Post(':id/reopen')
  @AdminRoles('SUPER_ADMIN')
  @UseGuards(UserThrottleGuard, StepUpGuard)
  // BAD-001/503: buka ulang disbursement CANCELLED → PENDING. SELALU via dual
  // control (DISBURSEMENT_REOPEN) — endpoint ini hanya membuat usulan PENDING;
  // eksekusi oleh admin kedua via POST /v1/admin/approvals/:id/approve.
  @RequireStepUp('disbursement.reopen', 'id')
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Buka ulang disbursement CANCELLED (SUPER_ADMIN, dual control)',
    description:
      'BAD-001: satu-satunya jalan resmi CANCELLED → PENDING. Selalu via dual control — ' +
      'endpoint ini hanya membuat usulan PENDING (mengembalikan approvalId); ' +
      'eksekusi oleh admin kedua. Requires X-Step-Up-Token (action disbursement.reopen) + Idempotency-Key.',
  })
  @ApiResponse({ status: 200, description: 'Usulan reopen dibuat (status PENDING).' })
  @ApiResponse({ status: 404, description: 'Disbursement tidak ditemukan.' })
  @ApiResponse({ status: 409, description: 'Disbursement bukan CANCELLED.' })
  reopenDisbursement(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AdminActionReasonDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.requestReopen(id, admin.sub, admin.role, dto.reason, req.ip || 'unknown');
  }
}
