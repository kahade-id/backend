import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ServiceBookingService } from '../services/service-booking.service';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRoute } from '../../../common/decorators/public.decorator';
import { AdminRole, SlotBookingStatus } from '@prisma/client';

/**
 * POIN 2 (2026-10-04): endpoint admin read-only untuk booking jasa.
 * Kontrak sesuai ekspektasi panel admin (halaman /bookings):
 *   GET /v1/admin/service-bookings — daftar (query: page, limit, status, search)
 * Respons: paginasi standar + relasi `slot` & `user` per booking.
 * Monitoring saja — TANPA aksi finansial.
 */
@ApiTags('admin-service-bookings')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.CUSTOMER_SUPPORT)
@AdminRoute()
@Controller('admin/service-bookings')
export class AdminServiceBookingsController {
  constructor(private readonly service: ServiceBookingService) {}

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get()
  @ApiOperation({ summary: 'Daftar booking jasa (admin, read-only)' })
  list(
    @Query('status') status: SlotBookingStatus | undefined,
    @Query('search') search: string | undefined,
    @Query() pagination: PaginationDto,
  ) {
    return this.service.listAdminBookings(pagination.page ?? 1, pagination.limit ?? 20, status, search);
  }
}
