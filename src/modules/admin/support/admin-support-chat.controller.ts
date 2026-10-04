import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Post, Body, Param, Query, UseGuards, Req } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRole } from '@prisma/client';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { Request } from 'express';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { SupportChatService } from '../../support/support-chat.service';
import { SupportMessageSenderType } from '@prisma/client';
import { ClaimConversationDto, ConversationQueryDto, EscalateConversationDto, SetAgentAvailabilityDto } from '../../support/dto/support-chat.dto';

/**
 * POIN 5 (2026-10-04) — admin livechat support (websocket penuh).
 *
 * Agen = AdminUser ber-role CUSTOMER_SUPPORT / SUPER_ADMIN, terhubung via
 * WebSocket dengan token admin (lihat RealtimeGateway). Endpoint REST di sini
 * untuk: antrean, claim/assign, tutup, eskalasi → tiket, dan status agen.
 * Pengiriman pesan utama lewat WS (`support.message`); REST hanya untuk
 * riwayat & manajemen.
 */
@ApiTags('admin-support-chat')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.CUSTOMER_SUPPORT)
@AdminRoute()
@Controller('admin/support/chat')
export class AdminSupportChatController {
  constructor(private readonly supportChat: SupportChatService) {}

  @Get('conversations')
  @ApiOperation({ summary: 'List support conversations (queue)', description: 'WAITING diprioritaskan (Kahade+ dulu, lalu FIFO).' })
  @ApiResponse({ status: 200, description: 'Conversation queue returned.' })
  getQueue(@Query() query: ConversationQueryDto): Promise<object> {
    return this.supportChat.getQueue(query.status, query.page ?? 1, query.limit ?? 20);
  }

  @Get('conversations/:conversationId')
  @ApiOperation({ summary: 'Get conversation detail (admin view)' })
  @ApiResponse({ status: 200, description: 'Conversation detail returned.' })
  @ApiResponse({ status: 404, description: 'Conversation not found.' })
  getDetail(@Param('conversationId', ParseIdPipe) conversationId: string): Promise<object> {
    return this.supportChat.getConversationForAdmin(conversationId);
  }

  @Get('conversations/:conversationId/messages')
  @ApiOperation({ summary: 'Paginated message history (admin view, cursor = ISO timestamp)' })
  getMessages(
    @Param('conversationId', ParseIdPipe) conversationId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<object> {
    const n = Math.min(Math.max(1, parseInt(limit ?? '30', 10) || 30), 100);
    return this.supportChat.getMessages(conversationId, { kind: 'admin', id: admin.sub }, cursor, n);
  }

  @UseGuards(UserThrottleGuard)
  @Post('conversations/:conversationId/claim')
  @ApiOperation({
    summary: 'Claim a conversation (WAITING/ASSIGNED → ASSIGNED)',
    description: 'Agen biasa hanya bisa claim untuk diri sendiri; SUPER_ADMIN boleh menugaskan ke agen lain via body.agentId.',
  })
  @ApiResponse({ status: 200, description: 'Conversation claimed.' })
  claim(
    @Param('conversationId', ParseIdPipe) conversationId: string,
    @Body() dto: ClaimConversationDto,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.supportChat.claimConversation(admin.sub, admin.role, conversationId, dto.agentId);
  }

  @UseGuards(UserThrottleGuard)
  @Post('conversations/:conversationId/close')
  @ApiOperation({ summary: 'Close a conversation as agent' })
  @ApiResponse({ status: 200, description: 'Conversation closed.' })
  close(
    @Param('conversationId', ParseIdPipe) conversationId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    // AGENTS.md (quirk jest+Prisma): nilai enum baru sebagai literal string.
    return this.supportChat.closeConversation(conversationId, 'AGENT' as SupportMessageSenderType, admin.sub);
  }

  @UseGuards(UserThrottleGuard)
  @Post('conversations/:conversationId/escalate')
  @ApiOperation({
    summary: 'Escalate conversation → support ticket (with transcript)',
    description: 'POIN 5: SATU-SATUNYA jalur pembuatan tiket. Membuat SupportTicket (sourceType=CHAT_ESCALATION) beserta transkrip.',
  })
  @ApiResponse({ status: 201, description: 'Ticket created from conversation.' })
  escalate(
    @Param('conversationId', ParseIdPipe) conversationId: string,
    @Body() dto: EscalateConversationDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.supportChat.escalateToTicket(admin.sub, conversationId, dto, req.ip ?? '');
  }

  @Get('agents')
  @ApiOperation({ summary: 'List support agents with online + availability status' })
  agents(): Promise<object> {
    return this.supportChat.getAgentsStatus();
  }

  @UseGuards(UserThrottleGuard)
  @Post('agents/availability')
  @ApiOperation({ summary: 'Toggle my availability for new support conversations' })
  availability(
    @Body() dto: SetAgentAvailabilityDto,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.supportChat.setAgentAvailability(admin.sub, dto.available);
  }
}
