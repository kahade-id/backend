import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminRole } from '@prisma/client';
import { AdminRoute } from '../../../common/decorators/public.decorator';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { AdminStoriesService } from './admin-stories.service';
import { AdminStoryListQueryDto, AdminStoryReportListQueryDto } from './dto/admin-story-query.dto';
import {
  AdminStoryReasonDto,
  BanStoryFeatureDto,
  HideStoryDto,
  ReviewStoryReportDto,
} from './dto/admin-story-action.dto';
import { StoryViewersQueryDto } from '../../stories/dto/story-query.dto';

@ApiTags('admin-stories')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.CUSTOMER_SUPPORT)
@AdminRoute()
@Controller('admin/stories')
export class AdminStoriesController {
  constructor(private readonly stories: AdminStoriesService) {}

  @Get()
  @ApiOperation({ summary: 'Daftar Story aktif/kedaluwarsa beserta metrik moderasi' })
  listStories(
    @Query() query: AdminStoryListQueryDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.stories.listStories(query, admin.sub, req.ip ?? '', req.headers['user-agent']);
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Metrik Story dan laporan moderasi' })
  getMetrics(@CurrentAdmin() admin: AdminJwtPayload, @Req() req: Request): Promise<object> {
    return this.stories.getMetrics(admin.sub, req.ip ?? '', req.headers['user-agent']);
  }

  @Get('reports')
  @ApiOperation({ summary: 'Antrean laporan Story dengan paginasi dan filter status' })
  listReports(
    @Query() query: AdminStoryReportListQueryDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.stories.listReports(query, admin.sub, req.ip ?? '', req.headers['user-agent']);
  }

  @Get('reports/:reportId')
  @ApiOperation({ summary: 'Detail laporan Story dan snapshot saat dilaporkan' })
  getReport(
    @Param('reportId', ParseIdPipe) reportId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<unknown> {
    return this.stories.getReport(reportId, admin.sub, req.ip ?? '', req.headers['user-agent']);
  }

  @Patch('reports/:reportId')
  @ApiOperation({ summary: 'Tinjau/tindaklanjuti laporan Story' })
  reviewReport(
    @Param('reportId', ParseIdPipe) reportId: string,
    @Body() dto: ReviewStoryReportDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.stories.reviewReport(
      reportId,
      dto,
      admin.sub,
      req.ip ?? '',
      req.headers['user-agent'],
    );
  }

  @Post('users/:userId/ban')
  @ApiOperation({ summary: 'Ban fitur Story untuk user, sementara atau permanen' })
  banStoryFeature(
    @Param('userId', ParseIdPipe) userId: string,
    @Body() dto: BanStoryFeatureDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.stories.banStoryFeature(
      userId,
      dto,
      admin.sub,
      req.ip ?? '',
      req.headers['user-agent'],
    );
  }

  @Delete('users/:userId/ban')
  @ApiOperation({ summary: 'Cabut ban fitur Story' })
  unbanStoryFeature(
    @Param('userId', ParseIdPipe) userId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.stories.unbanStoryFeature(
      userId,
      admin.sub,
      req.ip ?? '',
      req.headers['user-agent'],
    );
  }

  @Get(':storyId/viewers')
  @ApiOperation({ summary: 'Daftar viewer dan reaksi (akses dicatat di audit log)' })
  getStoryViewers(
    @Param('storyId', ParseIdPipe) storyId: string,
    @Query() query: StoryViewersQueryDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.stories.getStoryViewers(
      storyId,
      query.page,
      query.limit,
      admin.sub,
      req.ip ?? '',
      req.headers['user-agent'],
    );
  }

  @Get(':storyId/replies')
  @ApiOperation({ summary: 'Riwayat chat balasan; hanya bila Story memiliki laporan terbuka' })
  getStoryReplies(
    @Param('storyId', ParseIdPipe) storyId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.stories.getStoryReplies(
      storyId,
      admin.sub,
      req.ip ?? '',
      req.headers['user-agent'],
    );
  }

  @Get(':storyId')
  @ApiOperation({ summary: 'Preview konten Story dan audience (akses dicatat di audit log)' })
  getStoryDetail(
    @Param('storyId', ParseIdPipe) storyId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<unknown> {
    return this.stories.getStoryDetail(storyId, admin.sub, req.ip ?? '', req.headers['user-agent']);
  }

  @Delete(':storyId')
  @ApiOperation({ summary: 'Hapus permanen Story dan media (alasan wajib)' })
  deleteStory(
    @Param('storyId', ParseIdPipe) storyId: string,
    @Body() dto: AdminStoryReasonDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<{ deleted: true }> {
    return this.stories.deleteStory(
      storyId,
      dto,
      admin.sub,
      req.ip ?? '',
      req.headers['user-agent'],
    );
  }

  @Post(':storyId/hide')
  @ApiOperation({ summary: 'Sembunyikan Story sementara untuk peninjauan' })
  hideStory(
    @Param('storyId', ParseIdPipe) storyId: string,
    @Body() dto: HideStoryDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.stories.hideStory(storyId, dto, admin.sub, req.ip ?? '', req.headers['user-agent']);
  }

  @Post(':storyId/restore')
  @ApiOperation({ summary: 'Pulihkan Story yang disembunyikan dalam tujuh hari terakhir' })
  restoreStory(
    @Param('storyId', ParseIdPipe) storyId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.stories.restoreStory(storyId, admin.sub, req.ip ?? '', req.headers['user-agent']);
  }
}
