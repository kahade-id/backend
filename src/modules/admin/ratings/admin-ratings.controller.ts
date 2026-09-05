import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Delete, Patch, Param, Query, Body, UseGuards, Req } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminRatingsService } from './admin-ratings.service';
import { PaginatedResponse } from '../../../common/dto/pagination.dto';
import { RatingListQueryDto } from './dto/rating-list-query.dto';
import { RatingActionDto } from './dto/rating-action.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { Request } from 'express';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

@ApiTags('admin-ratings')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN', 'CUSTOMER_SUPPORT')
@AdminRoute()
@Controller('admin/ratings')
export class AdminRatingsController {
  constructor(private readonly service: AdminRatingsService) {}

  @Get()
  @ApiOperation({ summary: 'List all ratings' })
  @ApiResponse({ status: 200, description: 'Ratings list returned.' })
  listRatings(@Query() query: RatingListQueryDto): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.service.listRatings(query.page!, query.limit!, query.stars, query.flagged);
  }

  @UseGuards(UserThrottleGuard)
  @Delete(':ratingId')
  @ApiOperation({ summary: 'Hide (soft-remove) inappropriate rating' })
  @ApiResponse({ status: 200, description: 'Rating hidden.' })
  @ApiResponse({ status: 404, description: 'Rating not found.' })
  removeRating(
    @Param('ratingId', ParseIdPipe) ratingId: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
    @Body() dto: RatingActionDto,
  ): Promise<{ message: string; ratingId: string }> {
    return this.service.removeRating(ratingId, adminId, req.ip ?? '', dto.reason);
  }

  @UseGuards(UserThrottleGuard)
  @Patch(':ratingId/unhide')
  @ApiOperation({ summary: 'Unhide a previously hidden rating' })
  @ApiResponse({ status: 200, description: 'Rating unhidden.' })
  @ApiResponse({ status: 404, description: 'Rating not found.' })
  unhideRating(
    @Param('ratingId', ParseIdPipe) ratingId: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
    @Body() dto: RatingActionDto,
  ): Promise<{ message: string; ratingId: string }> {
    return this.service.unhideRating(ratingId, adminId, req.ip ?? '', dto.reason);
  }
}
