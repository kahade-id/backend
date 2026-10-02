import { AdminRoute } from '../../common/decorators/public.decorator';
import { Controller, Get, Put, Post, Delete, Param, Body, Query, UseGuards, HttpCode, HttpStatus, BadRequestException, ConflictException, Req } from '@nestjs/common';
import { Request } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { JwtAdminGuard } from '../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../common/types/jwt-payload.types';
import { OpsSettingsService, OpsSettingConflictError } from './ops-settings.service';
import { isManageableSetting, MANAGEABLE_SETTING_MAP } from './ops-settings.registry';
import { UpdateOpsSettingDto, TestOpsSettingDto } from './dto/update-ops-setting.dto';
import { StepUpGuard } from '../../common/guards/step-up.guard';
import { RequireStepUp } from '../../common/decorators/require-step-up.decorator';
// SEC-506: modul ini mengusulkan OPS_SETTING_CHANGE untuk key finansial
// (ApprovalsModule @Global — tanpa import modul).
import { ApprovalsService } from '../admin/approvals/approvals.service';

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
  constructor(
    private readonly settings: OpsSettingsService,
    private readonly approvals: ApprovalsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Daftar setting operasional (nilai secret ter-mask)' })
  @ApiResponse({ status: 200, description: 'Daftar setting.' })
  list() {
    return { settings: this.settings.list() };
  }

  @Get('translation/health')
  @ApiOperation({
    summary: 'Status konfigurasi layanan terjemahan',
    description: 'FAL-006: {configured, provider} — tanpa membocorkan API key.',
  })
  @ApiResponse({ status: 200, description: 'Status konfigurasi terjemahan.' })
  translationHealth(): { configured: boolean; provider: string | null } {
    const provider = this.settings.get('TRANSLATION_PROVIDER')?.trim() || null;
    const apiKey = this.settings.getSecret('TRANSLATION_API_KEY')?.trim() || null;
    return { configured: !!provider && !!apiKey, provider };
  }

  @Put(':key')
  @UseGuards(StepUpGuard)
  // SEC-506/503: ubah setting wajib step-up server-side. Key kategori
  // FINANSIAL (financial: true) TIDAK diubah langsung — dibuatkan usulan
  // dual control (OPS_SETTING_CHANGE) yang dieksekusi admin kedua.
  @RequireStepUp('opsSetting.update', 'key')
  @ApiOperation({
    summary: 'Ubah setting operasional (diaudit)',
    description:
      'SEC-506: key kategori FINANSIAL (mis. WALLET_ENABLED) tidak diubah langsung — ' +
      'endpoint mengembalikan usulan PENDING (approvalId); perubahan dieksekusi ' +
      'admin kedua via POST /v1/admin/approvals/:id/approve. Non-finansial langsung + audit. ' +
      'Wajib X-Step-Up-Token (action opsSetting.update).',
  })
  @ApiResponse({ status: 200, description: 'Setting diperbarui / usulan dual control dibuat.' })
  @ApiResponse({ status: 409, description: 'Konflik versi — setting berubah sejak dimuat.' })
  async update(
    @Param('key') key: string,
    @Body() dto: UpdateOpsSettingDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ) {
    if (!isManageableSetting(key)) {
      throw new BadRequestException(`Setting "${key}" tidak bisa dikelola via admin panel.`);
    }
    const adminId = admin.adminId ?? admin.sub ?? 'unknown';
    const def = MANAGEABLE_SETTING_MAP.get(key);
    // SEC-506: key finansial → via dual control (selalu propose, tidak eksekusi).
    if (def?.financial) {
      const approval = await this.approvals.propose({
        actionType: 'OPS_SETTING_CHANGE',
        targetId: key,
        payload: { value: dto.value },
        idempotencyKey: `ops-setting:${key}:${dto.expectedVersion ?? 'latest'}`,
        proposedBy: adminId,
        proposerRole: admin.role,
        ipAddress: req.ip ?? 'unknown',
      });
      return {
        approvalId: approval.approvalId,
        status: approval.status,
        expiresAt: approval.expiresAt,
        message:
          `Setting finansial "${key}" butuh dual control — usulan dibuat; ` +
          'perubahan dieksekusi admin kedua (POST /v1/admin/approvals/:id/approve).',
      };
    }
    try {
      const setting = await this.settings.set(
        key,
        dto.value,
        adminId,
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
  @UseGuards(StepUpGuard)
  // SEC-506/503: hapus override key finansial juga via dual control
  // (menghapus override bisa mengubah perilaku finansial via fallback .env).
  @RequireStepUp('opsSetting.update', 'key')
  @ApiOperation({
    summary: 'Hapus override panel — kembalikan ke default/.env (diaudit)',
    description:
      'SEC-506: key kategori FINANSIAL via dual control (usulan PENDING). Wajib X-Step-Up-Token.',
  })
  @ApiResponse({ status: 200, description: 'Override dihapus / usulan dual control dibuat.' })
  async remove(
    @Param('key') key: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ) {
    if (!isManageableSetting(key)) {
      throw new BadRequestException(`Setting "${key}" tidak bisa dikelola via admin panel.`);
    }
    const adminId = admin.adminId ?? admin.sub ?? 'unknown';
    const def = MANAGEABLE_SETTING_MAP.get(key);
    if (def?.financial) {
      const approval = await this.approvals.propose({
        actionType: 'OPS_SETTING_CHANGE',
        targetId: key,
        payload: { delete: true },
        idempotencyKey: `ops-setting-delete:${key}`,
        proposedBy: adminId,
        proposerRole: admin.role,
        ipAddress: req.ip ?? 'unknown',
      });
      return {
        approvalId: approval.approvalId,
        status: approval.status,
        expiresAt: approval.expiresAt,
        message:
          `Penghapusan override setting finansial "${key}" butuh dual control — usulan dibuat; ` +
          'dieksekusi admin kedua (POST /v1/admin/approvals/:id/approve).',
      };
    }
    try {
      const setting = await this.settings.delete(key, adminId);
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
