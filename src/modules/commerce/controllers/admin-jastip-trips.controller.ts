import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JastipService } from '../services/jastip.service';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRoute } from '../../../common/decorators/public.decorator';
import { AdminRole, JastipTripStatus } from '@prisma/client';

/**
 * FIX QA (2026-09-28): controller admin jastip yang hilang.
 * Kontrak sesuai ekspektasi panel admin (admin/src/lib/api/admin/jastip.ts):
 *   GET /v1/admin/jastip-trips     — daftar (query: page, limit, status, q)
 *   GET /v1/admin/jastip-trips/:id — detail trip (katalog + daftar pesanan)
 * Monitoring saja — TANPA aksi finansial.
 *
 * P3 @deprecated: Halaman admin untuk modul ini dihapus (TX-UNIFIED-V2).
 * Tidak ada pemanggil aktif. Dipertahankan untuk kompatibilitas; jangan
 * tambah endpoint baru di sini.
 */
@ApiTags('admin-jastip-trips')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.CUSTOMER_SUPPORT)
@AdminRoute()
@Controller('admin/jastip-trips')
export class AdminJastipTripsController {
  constructor(private readonly service: JastipService) {}

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get()
  @ApiOperation({ summary: 'Daftar trip jastip (admin)' })
  list(
    @Query('status') status: JastipTripStatus | undefined,
    @Query('q') q: string | undefined,
    @Query() pagination: PaginationDto,
  ) {
    return this.service.listAdminTrips(pagination.page ?? 1, pagination.limit ?? 20, status, q);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get(':id')
  @ApiOperation({ summary: 'Detail trip jastip (admin)' })
  detail(@Param('id') id: string) {
    return this.service.getAdminTripDetail(id);
  }
}
