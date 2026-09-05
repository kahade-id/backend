import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SettingsService } from './settings.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { PaginationDto, PaginatedResponse } from '../../common/dto/pagination.dto';
import { ReportUserSettingsDto } from './dto/report-user.dto';
import { UpdatePrivacyDto } from './dto/update-privacy.dto';
import { UpdateLanguageDto } from './dto/update-language.dto';

@ApiTags('settings')
@ApiBearerAuth('access-token')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get('blocked-users')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
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
  @Throttle({ default: { ttl: 3600000, limit: 5 } })
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
  @ApiOperation({ summary: 'Get privacy settings' })
  getPrivacySettings(@CurrentUser('sub') userId: string): Promise<{ profileVisible: boolean; showOnlineStatus: boolean }> {
    return this.settingsService.getPrivacySettings(userId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Put('privacy')
  @ApiOperation({ summary: 'Update privacy settings' })
  updatePrivacySettings(
    @CurrentUser('sub') userId: string,
    @Body() dto: UpdatePrivacyDto,
  ): Promise<{ profileVisible: boolean; showOnlineStatus: boolean; message: string }> {
    return this.settingsService.updatePrivacySettings(userId, dto);
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
  @ApiOperation({ summary: 'Request personal data export' })
  requestDataExport(
    @CurrentUser('sub') userId: string,
  ): Promise<{ message: string; downloadUrl: string; expiresAt: Date }> {
    return this.settingsService.requestDataExport(userId);
  }
}
