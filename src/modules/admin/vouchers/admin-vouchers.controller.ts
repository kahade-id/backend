import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Post, Param, Body, Query, UseGuards, Req, HttpCode } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminVouchersService } from './admin-vouchers.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { VoucherListQueryDto } from './dto/voucher-list-query.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

@ApiTags('admin-vouchers')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN', 'FINANCE_ADMIN')
@AdminRoute()
@Controller('admin/vouchers')
export class AdminVouchersController {
  constructor(private readonly service: AdminVouchersService) {}

  @Get()
  @ApiOperation({ summary: 'List all vouchers' })
  @ApiResponse({ status: 200, description: 'Vouchers list returned.' })
  listVouchers(@Query() query: VoucherListQueryDto): Promise<object> {
    return this.service.listVouchers(query.page!, query.limit!, query.isActive);
  }

  @Get(':voucherId')
  @ApiOperation({ summary: 'Get voucher detail with usage stats' })
  @ApiResponse({ status: 200, description: 'Voucher detail returned.' })
  @ApiResponse({ status: 404, description: 'Voucher not found.' })
  getVoucherDetail(@Param('voucherId', ParseIdPipe) voucherId: string): Promise<object> {
    return this.service.getVoucherDetail(voucherId);
  }

  @Post()
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Create new voucher' })
  @ApiResponse({ status: 201, description: 'Voucher created.' })
  createVoucher(
    @Body() dto: CreateVoucherDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.createVoucher(adminId, dto, req.ip ?? 'unknown');
  }

  @Post(':voucherId/deactivate')
  @UseGuards(UserThrottleGuard)
  @HttpCode(200)
  @ApiOperation({ summary: 'Deactivate voucher' })
  @ApiResponse({ status: 200, description: 'Voucher deactivated.' })
  @ApiResponse({ status: 404, description: 'Voucher not found.' })
  deactivateVoucher(
    @Param('voucherId', ParseIdPipe) voucherId: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.deactivateVoucher(voucherId, adminId, req.ip ?? 'unknown');
  }
}
