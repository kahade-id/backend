import { AdminRoute } from '../../common/decorators/public.decorator';
import { Controller, Get, Put, Body, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { JwtAdminGuard } from '../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../common/types/jwt-payload.types';
import { OpsSettingsService } from './ops-settings.service';
import { UpdateMaintenanceDto } from './dto/update-maintenance.dto';

/**
 * Item 9 (batch 2026-09-28) — Mode maintenance.
 *
 * SUPER_ADMIN ONLY. Flag disimpan di app_settings via modul ops-settings
 * (TANPA tabel baru): MAINTENANCE_MODE ("true"/"false") + MAINTENANCE_MESSAGE.
 * Middleware global MaintenanceMiddleware membaca flag ini (cache 60 dtk).
 */
@ApiTags('admin-maintenance')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN')
@AdminRoute()
@Controller('admin/maintenance')
export class AdminMaintenanceController {
  constructor(private readonly settings: OpsSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Status mode maintenance saat ini' })
  @ApiResponse({ status: 200, description: 'Status maintenance.' })
  getStatus() {
    return {
      enabled: this.settings.get('MAINTENANCE_MODE')?.trim().toLowerCase() === 'true',
      message: this.settings.get('MAINTENANCE_MESSAGE')?.trim() || null,
    };
  }

  @Put()
  @ApiOperation({ summary: 'Aktif/nonaktifkan mode maintenance + pesan' })
  @ApiResponse({ status: 200, description: 'Status maintenance diperbarui.' })
  async update(
    @Body() dto: UpdateMaintenanceDto,
    @CurrentAdmin() admin: AdminJwtPayload,
  ) {
    const adminId = admin.adminId ?? admin.sub ?? 'unknown';
    try {
      await this.settings.set('MAINTENANCE_MODE', dto.enabled ? 'true' : 'false', adminId);
      const message = dto.message?.trim();
      if (message) {
        await this.settings.set('MAINTENANCE_MESSAGE', message, adminId);
      }
      return {
        enabled: dto.enabled,
        message: this.settings.get('MAINTENANCE_MESSAGE')?.trim() || null,
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Gagal memperbarui mode maintenance.');
    }
  }
}
