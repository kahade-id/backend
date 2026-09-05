import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Badge } from '@prisma/client';
import { BadgesService } from './badges.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationDto, PaginatedResponse } from '../../common/dto/pagination.dto';

@ApiTags('badges')
@ApiBearerAuth('access-token')
@Controller('badges')
export class BadgesController {
  constructor(private readonly badgesService: BadgesService) {}

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get()
  @ApiOperation({ summary: 'List all available badges' })
  @ApiResponse({ status: 200, description: 'All badges returned.' })
  listBadges(
    @CurrentUser('sub') userId: string,
    @Query() pagination: PaginationDto,
  ): ReturnType<BadgesService['listAllBadges']> {
    return this.badgesService.listAllBadges(userId, pagination.page ?? 1, pagination.limit ?? 20);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('my')
  @ApiOperation({ summary: 'List current user earned badges (paginated)' })
  @ApiResponse({ status: 200, description: 'User badges returned.' })
  getMyBadges(
    @CurrentUser('sub') userId: string,
    @Query() pagination: PaginationDto,
  ): Promise<PaginatedResponse<{ id: string; earnedAt: Date; badge: Badge }>> {
    return this.badgesService.getMyBadges(userId, pagination.page ?? 1, pagination.limit ?? 50);
  }
}
