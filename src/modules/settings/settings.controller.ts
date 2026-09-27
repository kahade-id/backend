import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SettingsService, PrivacySettingsResponse, ConsentStatus, ExportRequestSummary } from './settings.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { PaginationDto, PaginatedResponse } from '../../common/dto/pagination.dto';
import { ReportUserSettingsDto } from './dto/report-user.dto';
import { UpdatePrivacyDto } from './dto/update-privacy.dto';
import { UpdateLanguageDto } from './dto/update-language.dto';
import { UpdateConsentDto } from './dto/update-consent.dto';
import { RequestExportDto } from './dto/request-export.dto';

@ApiTags('settings')
@ApiBearerAuth('access-token')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get('blocked-users')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'List blocked users', deprecated: true, description: 'Deprecated: gunakan GET /v1/users/me/blocked.' })
  listBlockedUsers(
    @CurrentUser('sub') userId: string,
    @Query() pagination: PaginationDto,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.settingsService.listBlockedUsers(
      userId,
      pagination.page ?? 1,
      pagination.limit ?? 20,
    );
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('block/:userId')
  blockUser(
    @CurrentUser('sub') currentUserId: string,
    @Param('userId', ParseIdPipe) targetUserId: string,
  ): Promise<{ message: string }> {
    return this.settingsService.blockUser(currentUserId, targetUserId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Delete('block/:userId')
  unblockUser(
    @CurrentUser('sub') currentUserId: string,
    @Param('userId', ParseIdPipe) targetUserId: string,
  ): Promise<{ message: string }> {
    return this.settingsService.unblockUser(currentUserId, targetUserId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 86400000, limit: 5 } })
  @Post('report')
  reportUser(
    @CurrentUser('sub') userId: string,
    @Body() dto: ReportUserSettingsDto,
  ): Promise<{ message: string; reportId: string }> {
    return this.settingsService.reportUser(userId, dto);
  }

  @Get('reports')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  listMyReports(
    @CurrentUser('sub') userId: string,
    @Query() pagination: PaginationDto,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.settingsService.listMyReports(
      userId,
      pagination.page ?? 1,
      pagination.limit ?? 20,
    );
  }

  @Get('privacy')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Get privacy settings (G076–G083)' })
  getPrivacySettings(@CurrentUser('sub') userId: string): Promise<PrivacySettingsResponse> {
    return this.settingsService.getPrivacySettings(userId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Put('privacy')
  @ApiOperation({ summary: 'Update privacy settings (G076–G083)' })
  updatePrivacySettings(
    @CurrentUser('sub') userId: string,
    @Body() dto: UpdatePrivacyDto,
  ): Promise<PrivacySettingsResponse & { message: string }> {
    return this.settingsService.updatePrivacySettings(userId, dto);
  }

  // ── G084–G086: persetujuan pemasaran vs transaksional ──

  @Get('consents')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Get current consent status per type' })
  getConsents(@CurrentUser('sub') userId: string): Promise<ConsentStatus[]> {
    return this.settingsService.getConsents(userId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Put('consents')
  @ApiOperation({
    summary: 'Grant or revoke a consent',
    description:
      'Persetujuan pemasaran dapat ditarik kapan saja. Notifikasi transaksional ' +
      'tidak dapat ditarik (penarikan ditolak dengan 400).',
  })
  updateConsent(
    @CurrentUser('sub') userId: string,
    @Body() dto: UpdateConsentDto,
    @Req() req: Request,
  ): Promise<ConsentStatus> {
    return this.settingsService.updateConsent(userId, dto, req.ip);
  }

  @Get('consents/history')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Consent history (versioned)' })
  getConsentHistory(
    @CurrentUser('sub') userId: string,
    @Query() pagination: PaginationDto,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.settingsService.getConsentHistory(
      userId,
      pagination.page ?? 1,
      pagination.limit ?? 20,
    );
  }

  @Get('language')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Get language preference' })
  getLanguage(@CurrentUser('sub') userId: string): Promise<{ language: string }> {
    return this.settingsService.getLanguage(userId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Put('language')
  @ApiOperation({ summary: 'Update language preference' })
  updateLanguage(
    @CurrentUser('sub') userId: string,
    @Body() dto: UpdateLanguageDto,
  ): Promise<{ language: string; message: string }> {
    return this.settingsService.updateLanguage(userId, dto.language);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 86400000, limit: 3 } })
  @Post('privacy/export')
  @ApiOperation({
    summary: 'Request personal data export (G087–G100)',
    description: 'format=json (default): satu berkas JSON. format=csv: ZIP berisi manifest + file per dataset.',
  })
  requestDataExport(
    @CurrentUser('sub') userId: string,
    @Query() query: RequestExportDto,
  ): Promise<{ message: string; downloadUrl: string; expiresAt: Date; requestId: string }> {
    return this.settingsService.requestDataExport(userId, query.format ?? 'json');
  }

  // ── G087–G088, G100: riwayat ekspor + unduhan tercatat ──

  @Get('exports')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'List data export requests (history + status + expiry)' })
  listExportRequests(
    @CurrentUser('sub') userId: string,
    @Query() pagination: PaginationDto,
  ): Promise<PaginatedResponse<ExportRequestSummary>> {
    return this.settingsService.listExportRequests(
      userId,
      pagination.page ?? 1,
      pagination.limit ?? 20,
    );
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Get('exports/:id/download')
  @ApiOperation({
    summary: 'Download an export archive (logged)',
    description:
      'Mencatat setiap akses unduhan dan menerbitkan URL signed baru bertanda ' +
      'waktu singkat (5 menit). Arsip yang kedaluwarsa ditolak.',
  })
  downloadExportRequest(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseIdPipe) requestId: string,
  ): Promise<{ downloadUrl: string; expiresAt: Date }> {
    return this.settingsService.downloadExportRequest(userId, requestId);
  }
}
