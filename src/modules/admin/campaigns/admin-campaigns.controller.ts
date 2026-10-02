import {
  Controller, Get, Post, Put, Delete, Body, Param, Query,
  ParseIntPipe, DefaultValuePipe, UseGuards, Req, HttpCode,
} from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ParseEnumQueryPipe } from '../../../common/pipes/parse-query-string.pipe';
import { ClampLimitPipe } from '../../../common/pipes/clamp-limit.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { CampaignService } from '../campaign.service';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { PauseCampaignDto, ActivateCampaignDto } from './dto/campaign-lifecycle.dto';
import { DeleteCampaignDto } from './dto/delete-campaign.dto';
import { DuplicateCampaignDto } from './dto/duplicate-campaign.dto';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { StepUpGuard } from '../../../common/guards/step-up.guard';
import { RequireStepUp } from '../../../common/decorators/require-step-up.decorator';

const CAMPAIGN_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED'];

@ApiTags('admin/campaigns')
@ApiBearerAuth('admin-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN')
@AdminRoute()
@Controller('admin/campaigns')
export class AdminCampaignsController {
  constructor(private campaignService: CampaignService) {}

  @UseGuards(UserThrottleGuard, StepUpGuard)
  @Post()
  // SYS-B-402: pembuatan campaign = definisi liabilitas promo.
  @RequireStepUp('campaign.create')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Create a campaign', description: 'SYS-B-402: requires X-Step-Up-Token (action campaign.create).' })
  async createCampaign(
    @CurrentAdmin('sub') adminId: string,
    @Body() dto: CreateCampaignDto,
    @Req() req: Request,
  ): Promise<object> {
    return this.campaignService.createCampaign(adminId, {
      ...dto,
      startsAt: new Date(dto.startsAt),
      endsAt: new Date(dto.endsAt),
    }, req.ip || 'unknown');
  }

  @Get()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'List campaigns (filter: status, pembuat, rentang tanggal)' })
  async getCampaigns(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), new ClampLimitPipe(100)) limit: number,
    @Query('status', new ParseEnumQueryPipe('status', CAMPAIGN_STATUSES)) status?: string,
    @Query('createdBy') createdBy?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<object> {
    return this.campaignService.getCampaigns(page, limit, status, {
      createdBy: createdBy?.trim() || undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  // Rute spesifik didaftarkan sebelum GET :campaignId generik.
  @Get(':campaignId/versions')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Riwayat versi kampanye (G358)' })
  async getCampaignVersions(
    @Param('campaignId', ParseIdPipe) campaignId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), new ClampLimitPipe(50)) limit: number,
  ): Promise<object> {
    return this.campaignService.getCampaignVersions(campaignId, page, limit);
  }

  @Get(':campaignId/analytics')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Analitik kampanye: redemption, biaya promo, kuota (G363-G365)' })
  async getCampaignAnalytics(
    @Param('campaignId', ParseIdPipe) campaignId: string,
  ): Promise<object> {
    return this.campaignService.getCampaignAnalytics(campaignId);
  }

  @Get(':campaignId')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Get campaign details' })
  async getCampaign(@Param('campaignId', ParseIdPipe) campaignId: string): Promise<object> {
    return this.campaignService.getCampaign(campaignId);
  }

  @UseGuards(UserThrottleGuard, StepUpGuard)
  @Post(':campaignId/activate')
  // SYS-B-402: aktivasi = liabilitas finansial lahir; nilai > ambang → dual control.
  @RequireStepUp('campaign.activate', 'campaignId')
  @Idempotency()
  @HttpCode(200)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Aktifkan kampanye — reason wajib, Idempotency-Key wajib (G359-G361)', description: 'SYS-B-402: requires X-Step-Up-Token (action campaign.activate). Nilai campaign di atas Rp1.000.000 wajib dual control (actionType CAMPAIGN_ACTIVATE).' })
  async activateCampaign(
    @CurrentAdmin('sub') adminId: string,
    @Param('campaignId', ParseIdPipe) campaignId: string,
    @Body() dto: ActivateCampaignDto,
    @Req() req: Request,
  ): Promise<object> {
    return this.campaignService.activateCampaign(campaignId, adminId, { reason: dto.reason }, req.ip || 'unknown');
  }

  @UseGuards(UserThrottleGuard, StepUpGuard)
  @Put(':campaignId')
  // SYS-B-402: update campaign (field promo bisa berubah saat DRAFT).
  @RequireStepUp('campaign.update', 'campaignId')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Update kampanye — changeReason wajib, field terkunci setelah DRAFT (G351-G355)', description: 'SYS-B-402: requires X-Step-Up-Token (action campaign.update).' })
  async updateCampaign(
    @CurrentAdmin('sub') adminId: string,
    @Param('campaignId', ParseIdPipe) campaignId: string,
    @Body() dto: UpdateCampaignDto,
    @Req() req: Request,
  ): Promise<object> {
    return this.campaignService.updateCampaign(campaignId, adminId, {
      ...dto,
      startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
      endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
    }, req.ip || 'unknown');
  }

  @UseGuards(UserThrottleGuard, StepUpGuard)
  @Post(':campaignId/pause')
  // SYS-B-402: pause menghentikan liabilitas — tetap butuh re-auth.
  @RequireStepUp('campaign.pause', 'campaignId')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Jeda kampanye — reason wajib (G359)', description: 'SYS-B-402: requires X-Step-Up-Token (action campaign.pause).' })
  async pauseCampaign(
    @CurrentAdmin('sub') adminId: string,
    @Param('campaignId', ParseIdPipe) campaignId: string,
    @Body() dto: PauseCampaignDto,
    @Req() req: Request,
  ): Promise<object> {
    return this.campaignService.pauseCampaign(campaignId, adminId, dto.reason, req.ip || 'unknown');
  }

  @UseGuards(UserThrottleGuard, StepUpGuard)
  @Post(':campaignId/duplicate')
  // SYS-B-402: duplikat membuat campaign baru (draf) dari definisi promo.
  @RequireStepUp('campaign.duplicate', 'campaignId')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Duplikat kampanye ke draf baru tanpa hasil redemption (G362)', description: 'SYS-B-402: requires X-Step-Up-Token (action campaign.duplicate).' })
  async duplicateCampaign(
    @CurrentAdmin('sub') adminId: string,
    @Param('campaignId', ParseIdPipe) campaignId: string,
    @Body() dto: DuplicateCampaignDto,
    @Req() req: Request,
  ): Promise<object> {
    return this.campaignService.duplicateCampaign(campaignId, adminId, { name: dto.name }, req.ip || 'unknown');
  }

  @UseGuards(UserThrottleGuard, StepUpGuard)
  @Delete(':campaignId')
  // SYS-B-402: hapus campaign (guard voucher terbit tetap berlaku di service).
  @RequireStepUp('campaign.delete', 'campaignId')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Hapus kampanye — guard voucher terbit, force hanya untuk DRAFT (G356-G357)', description: 'SYS-B-402: requires X-Step-Up-Token (action campaign.delete).' })
  async deleteCampaign(
    @CurrentAdmin('sub') adminId: string,
    @Param('campaignId', ParseIdPipe) campaignId: string,
    @Body() dto: DeleteCampaignDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.campaignService.deleteCampaign(campaignId, adminId, { force: dto.force, reason: dto.reason }, req.ip || 'unknown');
  }
}
