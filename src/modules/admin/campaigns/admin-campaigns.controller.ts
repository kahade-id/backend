import {
  Controller, Get, Post, Put, Delete, Body, Param, Query,
  ParseIntPipe, DefaultValuePipe, UseGuards, Req,
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
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

const CAMPAIGN_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED'];

@ApiTags('admin/campaigns')
@ApiBearerAuth('admin-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN')
@AdminRoute()
@Controller('admin/campaigns')
export class AdminCampaignsController {
  constructor(private campaignService: CampaignService) {}

  @UseGuards(UserThrottleGuard)
  @Post()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Create a campaign' })
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
  @ApiOperation({ summary: 'List campaigns' })
  async getCampaigns(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), new ClampLimitPipe(100)) limit: number,
    @Query('status', new ParseEnumQueryPipe('status', CAMPAIGN_STATUSES)) status?: string,
  ): Promise<object> {
    return this.campaignService.getCampaigns(page, limit, status);
  }

  @Get(':campaignId')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Get campaign details' })
  async getCampaign(@Param('campaignId', ParseIdPipe) campaignId: string): Promise<object> {
    return this.campaignService.getCampaign(campaignId);
  }

  @UseGuards(UserThrottleGuard)
  @Put(':campaignId')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Update a campaign' })
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

  @UseGuards(UserThrottleGuard)
  @Delete(':campaignId')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Delete a campaign' })
  async deleteCampaign(
    @CurrentAdmin('sub') adminId: string,
    @Param('campaignId', ParseIdPipe) campaignId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.campaignService.deleteCampaign(campaignId, adminId, req.ip || 'unknown');
  }
}
