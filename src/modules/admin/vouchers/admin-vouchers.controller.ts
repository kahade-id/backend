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
import { Idempotency } from '../../../common/decorators/idempotency.decorator';

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
  @Idempotency()
  @ApiOperation({ summary: 'Create new voucher', description: 'ADM-219: requires Idempotency-Key — double submit tidak membuat voucher ganda.' })
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
  @Idempotency()
  @HttpCode(200)
  @ApiOperation({ summary: 'Deactivate voucher', description: 'ADM-219: requires Idempotency-Key.' })
  @ApiResponse({ status: 200, description: 'Voucher deactivated.' })
  @ApiResponse({ status: 404, description: 'Voucher not found.' })
  deactivateVoucher(
    @Param('voucherId', ParseIdPipe) voucherId: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.deactivateVoucher(voucherId, adminId, req.ip ?? 'unknown');
  }

  @Post(':voucherId/reactivate')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @HttpCode(200)
  @ApiOperation({ summary: 'Reactivate voucher', description: 'ADM-218: mengaktifkan kembali voucher yang dinonaktifkan (flag lunak). Fail-closed bila voucher masih aktif atau sudah kedaluwarsa. Requires Idempotency-Key.' })
  @ApiResponse({ status: 200, description: 'Voucher reactivated.' })
  @ApiResponse({ status: 404, description: 'Voucher not found.' })
  @ApiResponse({ status: 400, description: 'Voucher already active or expired.' })
  reactivateVoucher(
    @Param('voucherId', ParseIdPipe) voucherId: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.reactivateVoucher(voucherId, adminId, req.ip ?? 'unknown');
  }
}
