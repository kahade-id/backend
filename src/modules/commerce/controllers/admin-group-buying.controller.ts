import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PatunganService } from '../services/patungan.service';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRoute } from '../../../common/decorators/public.decorator';
import { AdminRole, PatunganStatus } from '@prisma/client';

/**
 * FIX QA (2026-09-28): controller admin patungan yang hilang.
 * Kontrak sesuai ekspektasi panel admin (admin/src/lib/api/admin/group-buying.ts):
 *   GET /v1/admin/group-buying     — daftar (query: page, limit, status, q)
 *   GET /v1/admin/group-buying/:id — detail (progres + daftar peserta)
 * Monitoring saja — TANPA aksi finansial.
 *
 * P3 @deprecated: Halaman admin untuk modul ini dihapus (TX-UNIFIED-V2).
 * Tidak ada pemanggil aktif. Dipertahankan untuk kompatibilitas; jangan
 * tambah endpoint baru di sini.
 */
@ApiTags('admin-group-buying')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.CUSTOMER_SUPPORT)
@AdminRoute()
@Controller('admin/group-buying')
export class AdminGroupBuyingController {
  constructor(private readonly service: PatunganService) {}

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get()
  @ApiOperation({ summary: 'Daftar grup patungan (admin)' })
  list(
    @Query('status') status: PatunganStatus | undefined,
    @Query('q') q: string | undefined,
    @Query() pagination: PaginationDto,
  ) {
    return this.service.listAdminGroups(pagination.page ?? 1, pagination.limit ?? 20, status, q);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get(':id')
  @ApiOperation({ summary: 'Detail grup patungan (admin)' })
  detail(@Param('id') id: string) {
    return this.service.getAdminGroupDetail(id);
  }
}
