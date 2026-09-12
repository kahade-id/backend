import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { BusinessVerificationService } from './business-verification.service';
import { SubmitBusinessVerificationDto } from './dto/submit-business-verification.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotency } from '../../common/decorators/idempotency.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { PaginationDto, PaginatedResponse } from '../../common/dto/pagination.dto';

/**
 * Section 1(d) — Business Verification (badge "Business Verified").
 *
 * Cermin dari KycController: submit / resubmit / status / history, dengan
 * UserThrottleGuard + Throttle eksplisit + Idempotency pada endpoint mutasi.
 * Dokumen diupload terpisah lewat POST /upload/presigned-url
 * (purpose=BUSINESS_DOCUMENT) lalu POST /upload/confirm.
 */
@ApiTags('business-verification')
@ApiBearerAuth('access-token')
@Controller('business-verification')
export class BusinessVerificationController {
  constructor(private readonly service: BusinessVerificationService) {}

  @Post('submit')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @Idempotency()
  @ApiOperation({
    summary: 'Submit business verification (gunakan fileKey dari /upload/confirm)',
    description:
      'Hanya tersedia untuk akun dengan accountType=BUSINESS. Mengajukan NPWP, nama badan usaha, ' +
      'nomor akta/SIUP, dan dokumen pendukung untuk direview admin. Mengaktifkan badge ' +
      '"Business Verified" setelah APPROVED.',
  })
  @ApiResponse({ status: 201, description: 'Pengajuan tersimpan dengan status PENDING.' })
  @ApiResponse({ status: 400, description: 'Sudah ada pengajuan PENDING/APPROVED, NPWP duplikat, atau dokumen belum dikonfirmasi.' })
  @ApiResponse({ status: 403, description: 'Akun bukan BUSINESS, atau verifikasi sebelumnya sudah di-revoke.' })
  async submit(
    @CurrentUser('sub') userId: string,
    @Body() dto: SubmitBusinessVerificationDto,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    return this.service.submit(userId, dto, req.ip);
  }

  @Post('resubmit')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @Idempotency()
  @ApiOperation({
    summary: 'Resubmit business verification setelah ditolak',
    description: 'Hanya boleh dipanggil ketika pengajuan terakhir berstatus REJECTED dan cooldown 24 jam sudah lewat.',
  })
  @ApiResponse({ status: 201, description: 'Pengajuan baru tersimpan dengan status PENDING.' })
  @ApiResponse({ status: 400, description: 'Pengajuan terakhir bukan REJECTED, atau cooldown masih aktif.' })
  async resubmit(
    @CurrentUser('sub') userId: string,
    @Body() dto: SubmitBusinessVerificationDto,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    return this.service.resubmit(userId, dto, req.ip);
  }

  @Get('status')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Get current business verification status' })
  @ApiResponse({ status: 200, description: 'Status pengajuan terbaru beserta flag isBusinessVerified.' })
  async getStatus(@CurrentUser('sub') userId: string): Promise<Record<string, unknown>> {
    return this.service.getStatus(userId);
  }

  @Get('history')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'List all business verification requests (paginated)' })
  @ApiResponse({ status: 200, description: 'Riwayat pengajuan, terurut terbaru dengan tiebreak id.' })
  async getHistory(
    @CurrentUser('sub') userId: string,
    @Query() pagination: PaginationDto,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.service.getHistory(userId, pagination.page ?? 1, pagination.limit ?? 20);
  }
}
