/**
 * courier-admin.controller.ts — endpoint admin /v1/admin/courier/* (G247–G249).
 *
 * SYS-D-002 (2026-10-03): 13 endpoint tanpa pemanggil di admin web dihapus
 * (bills, refunds list/decide/mark-paid, catalog GET/PATCH, flags, bookings/failed,
 * tracking/stale). Endpoint yang tersisa di bawah semuanya dipakai halaman admin
 * kurir aktif (terverifikasi terhadap admin/src/lib/api/admin/courier.ts).
 * Guard tetap ketat (SUPER_ADMIN untuk mutasi).
 */
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRoute } from '../../common/decorators/public.decorator';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator';
import { JwtAdminGuard } from '../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { CourierService } from './courier.service';
import {
  UpdateAdminProviderFlagDto,
  ApproveShippingRefundDto,
} from './dto/courier.dto';

@ApiTags('admin-courier')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN', 'FINANCE_ADMIN', 'CUSTOMER_SUPPORT')
@AdminRoute()
@Controller('admin/courier')
export class CourierAdminController {
  constructor(private readonly courierService: CourierService) {}

  // -------------------------------------------------------------------------
  // Wave 2 integritas-139: endpoint yang dipakai halaman admin kurir aktif.
  // -------------------------------------------------------------------------

  @Get('shipments')
  @ApiOperation({ summary: 'Daftar shipment (filter bookingState/status/provider/stale/search)' })
  async listShipments(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('bookingState') bookingState?: string,
    @Query('status') status?: string,
    @Query('providerCode') providerCode?: string,
    @Query('staleHours') staleHours?: string,
    @Query('search') search?: string,
  ): Promise<unknown> {
    return this.courierService.listAdminShipments({
      page: Number(page) || 1,
      limit: Math.min(Number(limit) || 20, 100),
      bookingState,
      status,
      providerCode,
      staleHours: staleHours !== undefined ? Number(staleHours) : undefined,
      search,
    });
  }

  @Get('providers')
  @ApiOperation({ summary: 'Daftar provider + flag operasional' })
  async listProviders(): Promise<unknown> {
    return this.courierService.listAdminProviders();
  }

  @Patch('providers/:providerCode')
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Ubah flag operasional provider (enabled, wilayah, prioritas)' })
  async updateProviderFlag(
    @Param('providerCode') providerCode: string,
    @Body() dto: UpdateAdminProviderFlagDto,
    @CurrentAdmin('sub') adminId: string,
  ): Promise<unknown> {
    return this.courierService.updateAdminProviderFlag(providerCode, dto, adminId);
  }

  @Post('shipments/:id/retry-booking')
  @ApiOperation({ summary: 'Coba ulang booking yang GAGAL (fail-closed)' })
  async retryBooking(
    @Param('id') id: string,
    @CurrentAdmin('sub') adminId: string,
  ): Promise<unknown> {
    return this.courierService.retryShipmentBookingAdmin(id, adminId);
  }

  @Post('shipments/:id/refresh')
  @ApiOperation({ summary: 'Refresh tracking shipment (admin)' })
  async refreshShipment(
    @Param('id') id: string,
    @CurrentAdmin('sub') adminId: string,
  ): Promise<unknown> {
    return this.courierService.refreshShipmentTrackingAdmin(id, adminId);
  }

  @Get('reconciliation')
  @ApiOperation({ summary: 'Rekonsiliasi estimasi vs aktual per shipment' })
  async reconciliation(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('onlyMismatch') onlyMismatch?: string,
  ): Promise<unknown> {
    return this.courierService.getShippingReconciliation({
      page: Number(page) || 1,
      limit: Math.min(Number(limit) || 20, 100),
      onlyMismatch: onlyMismatch === 'true' || onlyMismatch === '1',
    });
  }

  @Post('shipments/:id/refunds/approve')
  @AdminRoles('SUPER_ADMIN', 'FINANCE_ADMIN')
  @ApiOperation({ summary: 'Setujui refund ongkir (state machine REQUESTED→APPROVED, tanpa sentuh wallet)' })
  async approveRefund(
    @Param('id') id: string,
    @Body() dto: ApproveShippingRefundDto,
    @CurrentAdmin('sub') adminId: string,
  ): Promise<unknown> {
    return this.courierService.approveShippingRefund(id, dto, adminId);
  }
}
