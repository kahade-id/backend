import { Controller, Get, Post, Param, Query, HttpCode, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SellerVouchersService } from '../services/seller-vouchers.service';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRoute } from '../../../common/decorators/public.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminRole } from '@prisma/client';

/**
 * FIX QA (2026-09-28): controller admin voucher seller yang hilang.
 * Kontrak sesuai ekspektasi panel admin (admin/src/lib/api/admin/seller-vouchers.ts):
 *   GET  /v1/admin/seller-vouchers            — daftar (query: page, limit, isActive, q)
 *   GET  /v1/admin/seller-vouchers/:id        — detail + riwayat pemakaian
 *   POST /v1/admin/seller-vouchers/:id/deactivate — nonaktifkan (idempoten)
 * Admin hanya memantau + menonaktifkan; pembuatan voucher tetap di aplikasi seller.
 */
@ApiTags('admin-seller-vouchers')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.CUSTOMER_SUPPORT)
@AdminRoute()
@Controller('admin/seller-vouchers')
export class AdminSellerVouchersController {
  constructor(private readonly service: SellerVouchersService) {}

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get()
  @ApiOperation({ summary: 'Daftar voucher seller (admin)' })
  list(
    @Query('isActive') isActive: 'true' | 'false' | undefined,
    @Query('q') q: string | undefined,
    @Query() pagination: PaginationDto,
  ) {
    return this.service.listAdminVouchers(pagination.page ?? 1, pagination.limit ?? 20, isActive, q);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get(':id')
  @ApiOperation({ summary: 'Detail voucher seller + riwayat pemakaian (admin)' })
  detail(@Param('id') id: string) {
    return this.service.getAdminVoucherDetail(id);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post(':id/deactivate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Nonaktifkan voucher seller (admin, idempoten)' })
  deactivate(@CurrentAdmin('adminId') adminId: string, @Param('id') id: string) {
    return this.service.deactivateAdminVoucher(id, adminId ?? 'unknown');
  }
}
