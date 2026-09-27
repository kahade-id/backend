import { Controller, Post, Param, Body, HttpCode, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { DisputeQuickEscalationService } from './dispute-quick-escalation.service';
import { JwtAdminGuard } from '../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { AdminRoute } from '../../common/decorators/public.decorator';
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator';
import { AdminRole } from '@prisma/client';

class QuickEscalateDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * BE-COMMERCE (2026-10-01) — item 16: eskalasi dispute 1 ketuk (admin).
 * POST /v1/admin/disputes/:id/quick-escalate — tanpa alasan wajib.
 */
@ApiTags('admin-disputes')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.DISPUTE_ADMIN, AdminRole.CUSTOMER_SUPPORT)
@AdminRoute()
@Controller('admin/disputes')
export class DisputeQuickEscalationController {
  constructor(private readonly service: DisputeQuickEscalationService) {}

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post(':id/quick-escalate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Eskalasi dispute 1 ketuk (admin)' })
  quickEscalate(@CurrentAdmin('adminId') adminId: string, @Param('id') id: string, @Body() dto: QuickEscalateDto) {
    return this.service.quickEscalate(adminId ?? 'unknown', id, dto?.note);
  }
}
