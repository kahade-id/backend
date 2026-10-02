import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { ShowcaseService } from '../../showcase/showcase.service';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRole } from '@prisma/client';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import {
  CommentModerationListQueryDto,
  ModerateCommentDto,
} from './dto/comment-moderation.dto';

/**
 * Audit 2026-10-03 (FAL-010): moderasi komentar showcase oleh Trust & Safety.
 * Sebelumnya admin tidak punya surface apa pun untuk komentar showcase —
 * hide hanya bisa dilakukan pemilik item.
 */
@ApiTags('admin-showcase-comments')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.DISPUTE_ADMIN, AdminRole.CUSTOMER_SUPPORT)
@AdminRoute()
@Controller('admin/showcase/comments')
export class AdminShowcaseCommentsController {
  constructor(private readonly showcaseService: ShowcaseService) {}

  @Get()
  @ApiOperation({
    summary: 'List showcase comments for moderation',
    description:
      'Daftar komentar lintas item dengan filter status (all|visible|hidden|deleted) + pencarian teks/author. Untuk Trust & Safety.',
  })
  @ApiResponse({ status: 200, description: 'Comments returned.' })
  list(@Query() query: CommentModerationListQueryDto): Promise<object> {
    return this.showcaseService.adminListComments(
      query.status ?? 'all',
      query.search,
      query.page ?? 1,
      query.limit ?? 20,
    );
  }

  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.DISPUTE_ADMIN)
  @Patch(':id')
  @ApiOperation({
    summary: 'Moderate a showcase comment (hide/unhide/delete)',
    description:
      'hide/unhide memakai field isHidden/hiddenReason/hiddenAt/hiddenBy; delete = soft-delete (FAL-027). Setiap aksi dicatat di audit log admin.',
  })
  @ApiResponse({ status: 200, description: 'Comment moderated.' })
  @ApiResponse({ status: 404, description: 'Comment not found.' })
  moderate(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: ModerateCommentDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.showcaseService.adminModerateComment(
      admin.sub,
      id,
      dto.action,
      dto.reason,
      req.ip ?? 'unknown',
    );
  }
}
