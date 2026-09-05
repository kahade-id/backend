import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminReferralService } from './admin-referral.service';
import { ReferralCodeQueryDto } from './dto/referral-code-query.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';

@ApiTags('admin-referral')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN', 'FINANCE_ADMIN')
@AdminRoute()
@Controller('admin/referral')
export class AdminReferralController {
  constructor(private readonly service: AdminReferralService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Platform referral statistics' })
  @ApiResponse({ status: 200, description: 'Referral stats returned.' })
  getReferralStats(): Promise<object> {
    return this.service.getReferralStats();
  }

  @Get('codes')
  @ApiOperation({ summary: 'List all referral codes' })
  @ApiResponse({ status: 200, description: 'Referral codes list returned.' })
  listReferralCodes(@Query() query: ReferralCodeQueryDto): Promise<object> {
    return this.service.listReferralCodes(query.page!, query.limit!, query.isActive);
  }
}
