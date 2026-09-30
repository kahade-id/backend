import { AdminRoute } from '../../common/decorators/public.decorator';
import { Controller, Get, Put, Post, Delete, Param, Body, Query, UseGuards, HttpCode, HttpStatus, BadRequestException, ConflictException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { JwtAdminGuard } from '../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../common/types/jwt-payload.types';
import { OpsSettingsService, OpsSettingConflictError } from './ops-settings.service';
import { isManageableSetting } from './ops-settings.registry';
import { UpdateOpsSettingDto, TestOpsSettingDto } from './dto/update-ops-setting.dto';

/**
 * OPS — Kelola setting operasional via admin panel.
 *
 * SUPER_ADMIN ONLY. Ini halaman paling sensitif di admin panel:
 * token integrasi bisa dibaca/diubah dari sini. Setiap aksi diaudit.
 * Boot secret & kunci kripto TIDAK ADA di sini by design.
 */
@ApiTags('admin-ops-settings')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN')
@AdminRoute()
@Controller('admin/ops-settings')
export class AdminOpsSettingsController {
  constructor(private readonly settings: OpsSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Daftar setting operasional (nilai secret ter-mask)' })
  @ApiResponse({ status: 200, description: 'Daftar setting.' })
  list() {
    return { settings: this.settings.list() };
  }

  @Put(':key')
  @ApiOperation({ summary: 'Ubah setting operasional (diaudit)' })
  @ApiResponse({ status: 200, description: 'Setting diperbarui.' })
  @ApiResponse({ status: 409, description: 'Konflik versi — setting berubah sejak dimuat.' })
  async update(
    @Param('key') key: string,
    @Body() dto: UpdateOpsSettingDto,
    @CurrentAdmin() admin: AdminJwtPayload,
  ) {
    if (!isManageableSetting(key)) {
      throw new BadRequestException(`Setting "${key}" tidak bisa dikelola via admin panel.`);
    }
    try {
      const setting = await this.settings.set(
        key,
        dto.value,
        admin.adminId ?? admin.sub ?? "unknown",
        { expectedVersion: dto.expectedVersion },
      );
      return { setting };
    } catch (err) {
      // BAI-118: konflik optimistic locking → 409 agar admin bisa
      // menampilkan dialog konflik, bukan error generik.
      if (err instanceof OpsSettingConflictError) {
        throw new ConflictException(err.message);
      }
      throw new BadRequestException(err instanceof Error ? err.message : 'Gagal menyimpan setting.');
    }
  }

  @Delete(':key')
  @ApiOperation({ summary: 'Hapus override panel — kembalikan ke default/.env (diaudit)' })
  @ApiResponse({ status: 200, description: 'Override dihapus; nilai kembali ke default.' })
  async remove(
    @Param('key') key: string,
    @CurrentAdmin() admin: AdminJwtPayload,
  ) {
    if (!isManageableSetting(key)) {
      throw new BadRequestException(`Setting "${key}" tidak bisa dikelola via admin panel.`);
    }
    try {
      const setting = await this.settings.delete(key, admin.adminId ?? admin.sub ?? "unknown");
      return { setting };
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Gagal menghapus setting.');
    }
  }

  @Post(':key/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Test koneksi setting (tanpa menyimpan)' })
  @ApiResponse({ status: 200, description: 'Hasil test koneksi.' })
  async test(
    @Param('key') key: string,
    @Body() dto: TestOpsSettingDto,
    @CurrentAdmin() admin: AdminJwtPayload,
  ) {
    if (!isManageableSetting(key)) {
      throw new BadRequestException(`Setting "${key}" tidak dikenal.`);
    }
    try {
      return await this.settings.testConnection(key, admin.adminId ?? admin.sub ?? "unknown", dto.candidateValue);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Test koneksi gagal.');
    }
  }

  @Get(':key/history')
  @ApiOperation({ summary: 'Riwayat perubahan setting (audit)' })
  @ApiResponse({ status: 200, description: 'Riwayat audit.' })
  async history(@Param('key') key: string, @Query('limit') limit?: string) {
    if (!isManageableSetting(key)) {
      throw new BadRequestException(`Setting "${key}" tidak dikenal.`);
    }
    const n = limit ? parseInt(limit, 10) : 20;
    return { history: await this.settings.history(key, Number.isFinite(n) ? n : 20) };
  }
}
