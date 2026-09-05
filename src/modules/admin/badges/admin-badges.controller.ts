import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards, Req, HttpCode } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminBadgesService } from './admin-badges.service';
import { CreateBadgeDto, UpdateBadgeDto } from './dto/create-badge.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { Request } from 'express';

@ApiTags('admin-badges')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN')
@AdminRoute()
@Controller('admin/badges')
export class AdminBadgesController {
  constructor(private readonly service: AdminBadgesService) {}

  @Get()
  @ApiOperation({ summary: 'List all badges' })
  @ApiResponse({ status: 200, description: 'Badges list returned.' })
  listBadges(@Query() pagination: PaginationDto): Promise<object> {
    return this.service.listBadges(pagination.page ?? 1, pagination.limit ?? 20);
  }

  @Get(':badgeId')
  @ApiOperation({ summary: 'Get badge detail with holders' })
  @ApiResponse({ status: 200, description: 'Badge detail returned.' })
  @ApiResponse({ status: 404, description: 'Badge not found.' })
  getBadgeDetail(@Param('badgeId', ParseIdPipe) badgeId: string): Promise<object> {
    return this.service.getBadgeDetail(badgeId);
  }

  @UseGuards(UserThrottleGuard)
  @Post()
  @ApiOperation({ summary: 'Create a new badge' })
  @ApiResponse({ status: 201, description: 'Badge created.' })
  createBadge(
    @Body() dto: CreateBadgeDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.createBadge(adminId, dto, req.ip ?? '');
  }

  @UseGuards(UserThrottleGuard)
  @Put(':badgeId')
  @ApiOperation({ summary: 'Update badge' })
  @ApiResponse({ status: 200, description: 'Badge updated.' })
  @ApiResponse({ status: 404, description: 'Badge not found.' })
  updateBadge(
    @Param('badgeId', ParseIdPipe) badgeId: string,
    @Body() dto: UpdateBadgeDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.updateBadge(badgeId, dto, adminId, req.ip ?? '');
  }

  @UseGuards(UserThrottleGuard)
  @Delete(':badgeId')
  @ApiOperation({ summary: 'Delete badge' })
  @ApiResponse({ status: 200, description: 'Badge deleted.' })
  @ApiResponse({ status: 404, description: 'Badge not found.' })
  deleteBadge(
    @Param('badgeId', ParseIdPipe) badgeId: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.deleteBadge(badgeId, adminId, req.ip ?? '');
  }

  @UseGuards(UserThrottleGuard)
  @Post(':badgeId/award/:userId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Award badge to user' })
  @ApiResponse({ status: 200, description: 'Badge awarded.' })
  @ApiResponse({ status: 404, description: 'Badge or user not found.' })
  @ApiResponse({ status: 409, description: 'User already has this badge.' })
  awardBadge(
    @Param('badgeId', ParseIdPipe) badgeId: string,
    @Param('userId', ParseIdPipe) userId: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.awardBadge(badgeId, userId, adminId, req.ip ?? '');
  }

  @UseGuards(UserThrottleGuard)
  @Delete(':badgeId/revoke/:userId')
  @ApiOperation({ summary: 'Revoke badge from user' })
  @ApiResponse({ status: 200, description: 'Badge revoked.' })
  @ApiResponse({ status: 404, description: 'User badge not found.' })
  revokeBadge(
    @Param('badgeId', ParseIdPipe) badgeId: string,
    @Param('userId', ParseIdPipe) userId: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.revokeBadge(badgeId, userId, adminId, req.ip ?? '');
  }
}
