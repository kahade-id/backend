import { AdminRoute } from '../../common/decorators/public.decorator';
import { Controller, Get, Put, Body, UseGuards, BadRequestException, ConflictException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { JwtAdminGuard } from '../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../common/types/jwt-payload.types';
import { OpsSettingsService, OpsSettingConflictError } from './ops-settings.service';
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
    // BAI-114: updatedAt/updatedBy diambil dari baris DB (bukan fabrikasi).
    const meta = this.settings.getMeta('MAINTENANCE_MODE');
    return {
      enabled: this.settings.get('MAINTENANCE_MODE')?.trim().toLowerCase() === 'true',
      message: this.settings.get('MAINTENANCE_MESSAGE')?.trim() || null,
      updatedAt: meta?.updatedAt ? meta.updatedAt.toISOString() : null,
      updatedBy: meta?.updatedBy ?? null,
    };
  }

  @Put()
  @ApiOperation({ summary: 'Aktif/nonaktifkan mode maintenance + pesan' })
  @ApiResponse({ status: 200, description: 'Status maintenance diperbarui.' })
  @ApiResponse({ status: 409, description: 'Konflik versi — maintenance berubah sejak dimuat.' })
  async update(
    @Body() dto: UpdateMaintenanceDto,
    @CurrentAdmin() admin: AdminJwtPayload,
  ) {
    const adminId = admin.adminId ?? admin.sub ?? 'unknown';
    try {
      const prevEnabled = this.settings.get('MAINTENANCE_MODE')?.trim().toLowerCase() === 'true';
      const prevMessage = this.settings.get('MAINTENANCE_MESSAGE')?.trim() || null;

      // BAI-113: MAINTENANCE_MODE hanya ditulis bila benar-benar berubah —
      // perubahan pesan saja tidak menaikkan version / menulis audit SET.
      // BAI-118: optimistic locking untuk toggle mode.
      if (dto.enabled !== prevEnabled) {
        const modeMeta = this.settings.getMeta('MAINTENANCE_MODE');
        await this.settings.set('MAINTENANCE_MODE', dto.enabled ? 'true' : 'false', adminId, {
          expectedVersion: modeMeta?.version,
        });
      }

      if (dto.message !== undefined) {
        const trimmed = dto.message.trim();
        if (trimmed && trimmed !== prevMessage) {
          // Pesan berubah → aksi audit berbeda dari toggle mode (BAI-113).
          await this.settings.set('MAINTENANCE_MESSAGE', trimmed, adminId, { auditAction: 'MESSAGE_UPDATED' });
        } else if (!trimmed && prevMessage !== null) {
          // BAI-105: string kosong eksplisit = RESET ke pesan default
          // (hapus override panel). "Tidak dikirim" (undefined) = pertahankan.
          await this.settings.delete('MAINTENANCE_MESSAGE', adminId);
        }
      }

      // BAI-114: updatedAt nyata dari baris DB yang paling baru diubah.
      const modeMeta = this.settings.getMeta('MAINTENANCE_MODE');
      const msgMeta = this.settings.getMeta('MAINTENANCE_MESSAGE');
      const latest = [modeMeta?.updatedAt, msgMeta?.updatedAt]
        .filter((d): d is Date => !!d)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      return {
        enabled: this.settings.get('MAINTENANCE_MODE')?.trim().toLowerCase() === 'true',
        message: this.settings.get('MAINTENANCE_MESSAGE')?.trim() || null,
        updatedAt: latest ? latest.toISOString() : null,
        updatedBy: modeMeta?.updatedBy ?? null,
      };
    } catch (err) {
      if (err instanceof OpsSettingConflictError) {
        throw new ConflictException(err.message);
      }
      throw new BadRequestException(err instanceof Error ? err.message : 'Gagal memperbarui mode maintenance.');
    }
  }
}
