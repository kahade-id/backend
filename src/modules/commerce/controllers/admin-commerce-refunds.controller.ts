import { Controller, Get, Post, Param, Body, Query, UseGuards, Req, HttpCode } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { IsOptional, IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PrismaService } from '../../../prisma/prisma.service';
import { CommerceRefundService } from '../services/commerce-refund.service';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
// P2: idempotensi untuk eksekusi refund manual (retry aman).
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminRoute } from '../../../common/decorators/public.decorator';
import { AdminRole, AuditAction, Prisma } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { StepUpGuard } from '../../../common/guards/step-up.guard';
import { RequireStepUp } from '../../../common/decorators/require-step-up.decorator';
import { AdminPasswordService } from '../../admin/auth/admin-password.service';
import { DUAL_CONTROL_THRESHOLD_SEN } from '../../admin/approvals/dual-control.constants';

class ExecuteRefundDto {
  @ApiPropertyOptional({ description: 'Alasan refund manual (audit trail)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiProperty({
    description:
      'SEC-602: password admin untuk re-auth server-side (pola AUT-013). ' +
      'Wajib untuk eksekusi refund manual.',
    maxLength: 72,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(72)
  reauthPassword!: string;
}

/**
 * M2 (SEC-B ronde 2) — fallback SLA manual untuk auto-refund.
 * Keputusan user FINAL: refund OTOMATIS via scheduler (Bull tiap 5 menit);
 * endpoint ini untuk admin mengeksekusi manual bila scheduler tertinggal /
 * butuh intervensi segera. SUPER_ADMIN + FINANCE_ADMIN, dengan audit trail.
 */
@ApiTags('admin-commerce-refunds')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.FINANCE_ADMIN)
@AdminRoute()
@Controller('admin/commerce/refunds')
export class AdminCommerceRefundsController {
  constructor(
    private readonly refunds: CommerceRefundService,
    private readonly prisma: PrismaService,
    // SEC-602: verifikasi password admin server-side (StepUpModule @Global).
    private readonly adminPassword: AdminPasswordService,
  ) {}

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('pending')
  @ApiOperation({ summary: 'Daftar peserta REFUND_REQUIRED (monitoring SLA refund)' })
  pending(@Query() pagination: PaginationDto) {
    return this.refunds.listPendingRefunds(pagination.page ?? 1, pagination.limit ?? 20);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post(':orderId/execute')
  @HttpCode(200)
  @UseGuards(StepUpGuard)
  // P2: idempotensi — retry tak-pasti dapat replay respons asli.
  @Idempotency()
  // SEC-602/503: eksekusi refund manual wajib step-up server-side (+ reauthPassword
  // di body, diverifikasi pola AUT-013). Nominal > Rp1jt → dual control
  // (COMMERCE_REFUND). Jalur scheduler otomatis (executeRefund) TIDAK digate.
  @RequireStepUp('commerce.refund', 'orderId')
  @ApiOperation({ summary: 'Eksekusi manual refund untuk order REFUND_REQUIRED (fallback SLA)', description: 'SEC-602/503: wajib X-Step-Up-Token (action commerce.refund) + reauthPassword di body. Nominal refund di atas Rp1.000.000 wajib dual control via POST /v1/admin/approvals/propose (actionType COMMERCE_REFUND).' })
  async execute(
    @Param('orderId') orderId: string,
    @Body() dto: ExecuteRefundDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ) {
    await this.adminPassword.verifyAdminPassword(adminId, dto.reauthPassword, 'commerce.refund', orderId, req.ip ?? '');
    const nominalSen = await this.refunds.getRefundableNominalSen(orderId);
    if (nominalSen > DUAL_CONTROL_THRESHOLD_SEN) {
      throw new ForbiddenException({
        code: ErrorCodes.DUAL_CONTROL_REQUIRED,
        message:
          'Nominal refund di atas Rp1.000.000 wajib dual control ' +
          '(usulkan via POST /v1/admin/approvals/propose dengan actionType COMMERCE_REFUND)',
      });
    }
    const reason = dto.reason?.trim() || 'Refund manual oleh admin (fallback SLA REFUND_REQUIRED)';
    const result = await this.refunds.executeRefundForOrder(orderId, adminId, reason);
    await this.prisma.adminAuditLog.create({
      data: {
        adminId,
        action: AuditAction.ORDER_FORCE_CANCEL,
        targetType: 'commerce-refund',
        targetId: orderId,
        description: `Eksekusi manual refund ${result.kind} participant=${result.participantId} order=${result.orderPublicId ?? orderId} oleh admin ${adminId}: ${result.outcome}`,
        after: { ...result, reason } as unknown as Prisma.InputJsonValue,
        ipAddress: req.ip || 'unknown',
        userAgent: req.headers['user-agent'] ?? null,
      },
    });
    return result;
  }
}
