import { Controller, Get, Post, Body, Param, Query, ParseIntPipe, DefaultValuePipe, UseGuards } from '@nestjs/common';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ClampLimitPipe } from '../../common/pipes/clamp-limit.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SupportService } from './support.service';
import { SupportChatService } from './support-chat.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ReplyTicketDto } from './dto/create-ticket.dto';
import { CreateConversationDto, RateConversationDto } from './dto/support-chat.dto';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';

@ApiTags('support')
@ApiBearerAuth('access-token')
@Controller('support')
export class SupportController {
  constructor(
    private supportService: SupportService,
    private supportChatService: SupportChatService,
  ) {}

  // POIN 5 (2026-10-04): POST /support/tickets DICABUT — tiket HANYA dibuat
  // admin via eskalasi livechat (POST /admin/support/chat/conversations/:id/escalate).
  // Klien yang masih memanggil endpoint ini menerima 404 dari router.

  @Get('tickets')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'List my support tickets' })
  async getTickets(
    @CurrentUser('sub') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe(50)) limit: number,
  ): Promise<object> {
    return this.supportService.getTickets(userId, page, limit);
  }

  // POIN 5: rute pembuatan tiket oleh user dicabut (lihat komentar di atas).

  @Get('tickets/:ticketId/fingerprint')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({
    summary: 'Get ticket fingerprint (lightweight)',
    description:
      'D1-010: fingerprint ringan untuk poll — status + updatedAt + jumlah balasan. Klien me-refresh bundle penuh hanya bila fingerprint berubah.',
  })
  async getTicketFingerprint(
    @CurrentUser('sub') userId: string,
    @Param('ticketId', ParseIdPipe) ticketId: string,
  ): Promise<{ ticketId: string; status: string; updatedAt: Date; replyCount: number }> {
    return this.supportService.getTicketFingerprint(userId, ticketId);
  }

  @Get('tickets/:ticketId')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Get ticket detail' })
  async getTicketDetail(
    @CurrentUser('sub') userId: string,
    @Param('ticketId', ParseIdPipe) ticketId: string,
  ): Promise<object> {
    return this.supportService.getTicketDetail(userId, ticketId);
  }

  @UseGuards(UserThrottleGuard)
  @Post('tickets/:ticketId/reply')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Reply to a ticket' })
  async replyToTicket(
    @CurrentUser('sub') userId: string,
    @Param('ticketId', ParseIdPipe) ticketId: string,
    @Body() dto: ReplyTicketDto,
  ): Promise<object> {
    return this.supportService.replyToTicket(userId, ticketId, dto);
  }

  @UseGuards(UserThrottleGuard)
  @Post('tickets/:ticketId/close')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Close own ticket (14.1)' })
  async closeTicket(@CurrentUser('sub') userId: string, @Param('ticketId', ParseIdPipe) ticketId: string): Promise<object> {
    return this.supportService.closeTicket(userId, ticketId);
  }

  @UseGuards(UserThrottleGuard)
  @Post('tickets/:ticketId/reopen')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Reopen own closed ticket' })
  async reopenTicket(@CurrentUser('sub') userId: string, @Param('ticketId', ParseIdPipe) ticketId: string): Promise<object> {
    return this.supportService.reopenTicket(userId, ticketId);
  }

  @UseGuards(UserThrottleGuard)
  @Post('tickets/:ticketId/rate')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Rate resolved ticket (14.1)' })
  async rateTicket(@CurrentUser('sub') userId: string, @Param('ticketId', ParseIdPipe) ticketId: string, @Body() dto: { rating: number; comment?: string }): Promise<object> {
    return this.supportService.rateTicket(userId, ticketId, dto.rating, dto.comment);
  }

  // ------------------------------------------------------- livechat ---

  @Get('chat/conversations')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'List my support conversations' })
  async listConversations(@CurrentUser('sub') userId: string): Promise<object> {
    return this.supportChatService.listMyConversations(userId);
  }

  @UseGuards(UserThrottleGuard)
  @Post('chat/conversations')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Get or create my active support conversation',
    description: 'Idempoten: satu user hanya punya satu percakapan aktif (WAITING/ASSIGNED/OPEN).',
  })
  async getOrCreateConversation(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateConversationDto,
  ): Promise<object> {
    return this.supportChatService.getOrCreateConversation(userId, dto.source ?? 'APP', dto.subject);
  }

  @Get('chat/conversations/:conversationId')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: 'Get my support conversation detail' })
  async getConversation(
    @CurrentUser('sub') userId: string,
    @Param('conversationId', ParseIdPipe) conversationId: string,
  ): Promise<object> {
    return this.supportChatService.getConversationForUser(userId, conversationId);
  }

  @Get('chat/conversations/:conversationId/messages')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: 'Paginated message history (cursor = ISO timestamp)' })
  async getConversationMessages(
    @CurrentUser('sub') userId: string,
    @Param('conversationId', ParseIdPipe) conversationId: string,
    @Query('cursor') cursor?: string,
    @Query('limit', new DefaultValuePipe(30), ParseIntPipe, new ClampLimitPipe(100)) limit?: number,
  ): Promise<object> {
    return this.supportChatService.getMessages(conversationId, { kind: 'user', id: userId }, cursor, limit ?? 30);
  }

  @UseGuards(UserThrottleGuard)
  @Post('chat/conversations/:conversationId/close')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Close my support conversation' })
  async closeConversation(
    @CurrentUser('sub') userId: string,
    @Param('conversationId', ParseIdPipe) conversationId: string,
  ): Promise<object> {
    // AGENTS.md (quirk jest+Prisma): nilai enum baru sebagai literal string.
    return this.supportChatService.closeConversation(conversationId, 'USER' as never, userId);
  }

  @UseGuards(UserThrottleGuard)
  @Post('chat/conversations/:conversationId/rate')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Rate a closed support conversation (1-5)' })
  async rateConversation(
    @CurrentUser('sub') userId: string,
    @Param('conversationId', ParseIdPipe) conversationId: string,
    @Body() dto: RateConversationDto,
  ): Promise<object> {
    return this.supportChatService.rateConversation(userId, conversationId, dto.rating, dto.comment);
  }
}
