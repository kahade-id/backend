import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
  DefaultValuePipe,
} from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ClampLimitPipe } from '../../../common/pipes/clamp-limit.pipe';
import { ParseQueryStringPipe } from '../../../common/pipes/parse-query-string.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminChatService } from './admin-chat.service';
import { ModerationEventQueryDto, ReviewModerationEventDto } from './dto/moderation-query.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRole, ChatModerationStatus } from '@prisma/client';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { ChatService } from '../../chat/chat.service';

@ApiTags('admin-chat')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.DISPUTE_ADMIN, AdminRole.CUSTOMER_SUPPORT)
@AdminRoute()
@Controller('admin/chat')
export class AdminChatController {
  constructor(
    private readonly service: AdminChatService,
    private readonly chatService: ChatService,
  ) {}

  @Get('moderation-events/stats')
  @ApiOperation({
    summary: 'Trust & Safety moderation queue statistics',
    description:
      'Counts of pending events, events in the last 24h, and breakdowns by severity and action.',
  })
  @ApiResponse({ status: 200, description: 'Stats returned.' })
  getStats(): Promise<object> {
    return this.service.getModerationStats();
  }

  @Get('moderation-events')
  @ApiOperation({
    summary: 'List chat moderation events',
    description:
      'Audit trail for the chat content filter, including BLOCKED messages that were never persisted. Filter by status, severity, action, or kind.',
  })
  @ApiResponse({ status: 200, description: 'Moderation events returned.' })
  listEvents(@Query() query: ModerationEventQueryDto): Promise<object> {
    return this.service.listModerationEvents(query);
  }

  @Get('moderation-events/:eventId')
  @ApiOperation({ summary: 'Get moderation event detail' })
  @ApiResponse({ status: 200, description: 'Event returned.' })
  @ApiResponse({ status: 404, description: 'Event not found.' })
  getEventDetail(@Param('eventId', ParseIdPipe) eventId: string): Promise<object> {
    return this.service.getModerationEventDetail(eventId);
  }

  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.DISPUTE_ADMIN)
  @Post('moderation-events/:eventId/review')
  @ApiOperation({
    summary: 'Review a moderation event',
    description:
      'Marks an event as REVIEWED, DISMISSED (false positive), or ACTIONED. Every review is written to the admin audit log.',
  })
  @ApiResponse({ status: 200, description: 'Event reviewed.' })
  @ApiResponse({ status: 404, description: 'Event not found.' })
  reviewEvent(
    @Param('eventId', ParseIdPipe) eventId: string,
    @Body() dto: ReviewModerationEventDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.reviewModerationEvent(
      eventId,
      admin.sub,
      (dto.status ?? 'REVIEWED') as ChatModerationStatus,
      dto.note,
      req.ip ?? 'unknown',
    );
  }

  @Get('users/:userId/moderation-events')
  @ApiOperation({
    summary: 'Moderation history for one user',
    description:
      'Repeated CIRCUMVENTION events are a much stronger trust signal than a single blocked message.',
  })
  listUserEvents(
    @Param('userId', ParseIdPipe) userId: string,
    @Query('limit', new DefaultValuePipe(50), new ClampLimitPipe(100)) limit?: number,
  ): Promise<object> {
    return this.service.listUserModerationEvents(userId, limit);
  }

  @Get('rooms/:roomId/messages')
  @ApiOperation({
    summary: 'Read a chat room as admin',
    description:
      'Returns chat messages including soft-deleted ones (`includeDeleted=true` keeps the original content in `deletedContent`). Reading a conversation is audit-logged.',
  })
  @ApiResponse({ status: 200, description: 'Messages returned.' })
  getRoomMessages(
    @Param('roomId', ParseIdPipe) roomId: string,
    @Query('cursor', new ParseQueryStringPipe('cursor', 100)) cursor?: string,
    @Query('limit', new DefaultValuePipe(50), new ClampLimitPipe(100)) limit?: number,
    @Query('includeDeleted') includeDeleted?: string,
  ): Promise<object> {
    return this.chatService.getRoomMessagesForAdmin(roomId, {
      limit,
      cursor,
      includeDeleted: includeDeleted === 'true',
    });
  }
}
