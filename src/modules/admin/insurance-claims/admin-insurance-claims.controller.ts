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
import { Request } from 'express';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

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
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Ubah status klaim asuransi (APPROVED/REJECTED/PAID)' })
  @ApiResponse({ status: 200, description: 'Status klaim diperbarui.' })
  @ApiResponse({ status: 404, description: 'Klaim tidak ditemukan.' })
  reviewClaim(
    @Param('claimId', ParseIdPipe) claimId: string,
    @Body() dto: ReviewInsuranceClaimDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.reviewClaim(claimId, dto.status, dto.note, adminId, req.ip ?? '');
  }
}
