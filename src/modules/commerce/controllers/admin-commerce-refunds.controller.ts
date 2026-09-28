import { Controller, Get, Post, Param, Body, Query, UseGuards, Req, HttpCode } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PrismaService } from '../../../prisma/prisma.service';
import { CommerceRefundService } from '../services/commerce-refund.service';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminRoute } from '../../../common/decorators/public.decorator';
import { AdminRole, AuditAction, Prisma } from '@prisma/client';

class ExecuteRefundDto {
  @ApiPropertyOptional({ description: 'Alasan refund manual (audit trail)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
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
  @ApiOperation({ summary: 'Eksekusi manual refund untuk order REFUND_REQUIRED (fallback SLA)' })
  async execute(
    @Param('orderId') orderId: string,
    @Body() dto: ExecuteRefundDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ) {
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
