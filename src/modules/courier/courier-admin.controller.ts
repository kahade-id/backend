/**
 * courier-admin.controller.ts — endpoint admin /v1/admin/courier/* (G247–G249).
 *
 * ADM-412 (2026-09-27): endpoint tulis di bawah ini (bills, refunds decide/mark-paid,
 * catalog PATCH, flags) BELUM memiliki pemanggil di admin web — attack surface tanpa
 * konsumen UI. Guard tetap ketat (SUPER_ADMIN untuk mutasi). Keputusan produk yang
 * dibutuhkan: (a) bangun UI-nya, atau (b) nonaktifkan endpoint sampai UI siap.
 * Jangan menambah pemanggil baru tanpa meninjau ulang kebutuhan bisnisnya.
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
  CreateBillDto,
  AddBillLinesDto,
  DecideRefundDto,
  ToggleFlagDto,
  UpdateCatalogDto,
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

  @Get('catalog')
  @ApiOperation({ summary: 'Katalog kurir + status flag (G227/G249)' })
  async getCatalog(): Promise<unknown> {
    return this.courierService.getCatalog();
  }

  @Patch('catalog/:providerCode/:serviceCode')
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Ubah entri katalog (enabled, regions, SLA)' })
  async updateCatalog(
    @Param('providerCode') providerCode: string,
    @Param('serviceCode') serviceCode: string,
    @Body() dto: UpdateCatalogDto,
    @CurrentAdmin('sub') adminId: string,
  ): Promise<unknown> {
    return this.courierService.updateCatalog(providerCode, serviceCode, dto, adminId);
  }

  @Post('flags/:providerCode/:region')
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Toggle feature flag provider/wilayah (G249)' })
  async toggleFlag(
    @Param('providerCode') providerCode: string,
    @Param('region') region: string,
    @Body() dto: ToggleFlagDto,
    @CurrentAdmin('sub') adminId: string,
  ): Promise<unknown> {
    return this.courierService.toggleRegionFlag(providerCode, region, dto, adminId);
  }

  @Get('bookings/failed')
  @ApiOperation({ summary: 'Booking gagal (G247)' })
  async failedBookings(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    return this.courierService.listFailedBookings(Number(page) || 1, Math.min(Number(limit) || 20, 100));
  }

  @Get('tracking/stale')
  @ApiOperation({ summary: 'Tracking macet / stale (G247)' })
  async staleTracking(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    return this.courierService.listStaleTracking(Number(page) || 1, Math.min(Number(limit) || 20, 100));
  }

  @Post('bills')
  @AdminRoles('SUPER_ADMIN', 'FINANCE_ADMIN')
  @ApiOperation({ summary: 'Catat tagihan provider per periode (G248)' })
  async createBill(@Body() dto: CreateBillDto, @CurrentAdmin('sub') adminId: string): Promise<unknown> {
    return this.courierService.createBill(dto, adminId);
  }

  @Get('bills')
  @AdminRoles('SUPER_ADMIN', 'FINANCE_ADMIN')
  @ApiOperation({ summary: 'Daftar tagihan provider' })
  async listBills(@Query('page') page?: string, @Query('limit') limit?: string): Promise<unknown> {
    return this.courierService.listBills(Number(page) || 1, Math.min(Number(limit) || 20, 100));
  }

  @Get('bills/:id')
  @AdminRoles('SUPER_ADMIN', 'FINANCE_ADMIN')
  @ApiOperation({ summary: 'Detail tagihan + baris rekonsiliasi' })
  async getBill(@Param('id') id: string): Promise<unknown> {
    return this.courierService.getBillDetail(id);
  }

  @Post('bills/:id/lines')
  @AdminRoles('SUPER_ADMIN', 'FINANCE_ADMIN')
  @ApiOperation({ summary: 'Tambah baris tagihan (per resi)' })
  // SEC-204: DTO tervalidasi — billedAmount NaN/negatif dan lines non-array
  // ditolak 400 oleh ValidationPipe sebelum menyentuh BigInt/rekonsiliasi.
  async addBillLines(@Param('id') id: string, @Body() dto: AddBillLinesDto): Promise<unknown> {
    return this.courierService.addBillLines(id, dto.lines);
  }

  @Post('bills/:id/reconcile')
  @AdminRoles('SUPER_ADMIN', 'FINANCE_ADMIN')
  @ApiOperation({ summary: 'Rekonsiliasi tagihan vs biaya tercatat (G248)' })
  async reconcileBill(@Param('id') id: string, @CurrentAdmin('sub') adminId: string): Promise<unknown> {
    return this.courierService.reconcileBill(id, adminId);
  }

  @Get('refunds')
  @ApiOperation({ summary: 'Daftar refund ongkir (G247)' })
  async listRefunds(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    return this.courierService.listRefunds(status, Number(page) || 1, Math.min(Number(limit) || 20, 100));
  }

  @Post('refunds/:id/decide')
  @AdminRoles('SUPER_ADMIN', 'FINANCE_ADMIN')
  @ApiOperation({ summary: 'Putus refund ongkir (setujui/tolak)' })
  async decideRefund(
    @Param('id') id: string,
    @Body() dto: DecideRefundDto,
    @CurrentAdmin('sub') adminId: string,
  ): Promise<unknown> {
    return this.courierService.decideRefund(id, dto, adminId);
  }

  @Post('refunds/:id/mark-paid')
  @AdminRoles('SUPER_ADMIN', 'FINANCE_ADMIN')
  @ApiOperation({ summary: 'Tandai refund ongkir sudah dibayar' })
  async markRefundPaid(@Param('id') id: string, @CurrentAdmin('sub') adminId: string): Promise<unknown> {
    return this.courierService.markRefundPaid(id, adminId);
  }

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
