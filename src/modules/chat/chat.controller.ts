import { Controller, Get, Post, Patch, Put, Delete, Body, Param, Query, DefaultValuePipe, ParseIntPipe, ParseBoolPipe, HttpCode, UseGuards, UseInterceptors, UploadedFile, BadRequestException, Res } from '@nestjs/common';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ClampLimitPipe } from '../../common/pipes/clamp-limit.pipe';
import { ParseQueryStringPipe } from '../../common/pipes/parse-query-string.pipe';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { ChatService } from './chat.service';
import { UploadService } from '../upload/upload.service';
import { MulterTooLargeInterceptor } from '../upload/multer-too-large.interceptor';
import { UploadPurpose } from '../upload/dto/presigned-url.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotency } from '../../common/decorators/idempotency.decorator';
import { SendMessageDto } from './dto/send-message.dto';
import { EditMessageDto } from './dto/edit-message.dto';
import { AddReactionDto } from './dto/reaction.dto';
import { ForwardMessageDto } from './dto/forward-message.dto';
import { ArchiveRoomDto, MuteRoomDto } from './dto/room-state.dto';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import { CreateDmDto } from './dto/create-dm.dto';
// Batch 43 BE-CHAT
import { Response } from 'express';
import { TranslateMessageDto } from './dto/translate-message.dto';
import { CreatePollDto, VotePollDto } from './dto/poll.dto';
import { CreateReplyTemplateDto, UpdateReplyTemplateDto } from './dto/reply-template.dto';
import { UpdateChatPrivacyDto } from './dto/chat-privacy.dto';
import { CreateOrderFromChatDto } from './dto/create-order-from-chat.dto';
import { PinRoomDto as PinChatRoomDto, ReportRoomDto } from './dto/room-report-pin.dto';
import { PhoneVerifiedGuard } from '../../common/guards/phone-verified.guard';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import {
  CHAT_SEARCH_MAX_LIMIT,
  CHAT_SEARCH_MIN_QUERY_LENGTH,
  CHAT_ATTACHMENT_MAX_BYTES,
} from '../../common/constants/app.constants';

interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@ApiTags('chat')
@ApiBearerAuth('access-token')
@UseGuards(PhoneVerifiedGuard)
@Controller('chat')
export class ChatController {
  constructor(
    private chatService: ChatService,
    private uploadService: UploadService,
  ) {}

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('unread-count')
  @ApiOperation({
    summary: 'Total unread chat messages for current user (lightweight badge)',
    description:
      'NS-006 (perf-fix): SATU angka agregat dari counter `chat_room_members.unreadCount` ' +
      '(lihat BD-004) — bukan daftar room penuh. Pengganti ringan pemakaian ' +
      '`GET /v1/chat/rooms?limit=50` tiap 60 detik hanya untuk badge tab Pesan. ' +
      'Additive-only: endpoint baru, tidak mengubah endpoint lain.',
  })
  async getUnreadCount(
    @CurrentUser('sub') userId: string,
  ): Promise<{ unreadCount: number }> {
    return this.chatService.getTotalUnreadCount(userId);
  }

  @Get('rooms')
  @ApiOperation({
    summary: 'List chat rooms for current user',
    description: 'Includes ORDER rooms and pre-transaction INQUIRY rooms. Archived rooms are hidden unless `archived=true`. Optional `q` searches room subject and participant name/username server-side.',
  })
  async getRooms(
    @CurrentUser('sub') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
    @Query('type') type?: string,
    @Query('archived', new DefaultValuePipe(false), ParseBoolPipe) archived?: boolean,
    @Query('q', new ParseQueryStringPipe('q', 100)) q?: string,
  ): Promise<object> {
    const normalizedType = type === 'INQUIRY' ? 'INQUIRY' : type === 'ORDER' ? 'ORDER' : undefined;
    return this.chatService.getRooms(userId, { page, limit, type: normalizedType, archived, q });
  }

  @Get('rooms/:roomId')
  @ApiOperation({
    summary: 'Get a single chat room (lightweight)',
    description:
      'D1-003: satu room untuk header layar percakapan — tanpa mengunduh ulang seluruh daftar room. Bentuk payload sama dengan satu entri GET /v1/chat/rooms. 404 bila viewer bukan anggota.',
  })
  async getRoom(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
  ): Promise<object> {
    return this.chatService.getRoom(userId, roomId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 3600000, limit: 10 } })
  @Idempotency()
  @Post('inquiries')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Open a pre-transaction conversation',
    description:
      'Starts (or reuses) an INQUIRY room with another user so buyer and seller can negotiate before an order is created and funds are locked in escrow.',
  })
  async createInquiry(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateInquiryDto,
  ): Promise<object> {
    return this.chatService.createInquiry(userId, dto);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('dm')
  @ApiOperation({
    summary: 'Open or reuse a DM room',
    description:
      'Get-or-create a direct conversation room with another user by username, without ' +
      'requiring a first message (WhatsApp-like "Kirim Pesan" from a profile). Reuses the ' +
      'existing INQUIRY room when one exists; otherwise creates an empty one.',
  })
  async getOrCreateDm(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateDmDto,
  ): Promise<object> {
    return this.chatService.getOrCreateDm(userId, dto.username);
  }

  @Get('search')
  @ApiOperation({
    summary: 'Search across all of the current user\'s conversations',
    description: `Substring search (min ${CHAT_SEARCH_MIN_QUERY_LENGTH} chars) over message content in every room the user participates in.`,
  })
  async searchAllMessages(
    @CurrentUser('sub') userId: string,
    @Query('q', new ParseQueryStringPipe('q', 100)) q: string,
    @Query('limit', new DefaultValuePipe(20), new ClampLimitPipe(CHAT_SEARCH_MAX_LIMIT)) limit?: number,
  ): Promise<object> {
    return this.chatService.searchAllMessages(userId, q, { limit });
  }

  @Get('rooms/:roomId/messages')
  @ApiOperation({ summary: 'Get messages in a chat room (cursor-based pagination)' })
  async getMessages(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Query('cursor', new ParseQueryStringPipe('cursor', 100)) cursor?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('excludeIds') excludeIdsRaw?: string,
    // D1-004: mode delta — hanya pesan lebih baru dari id ini (untuk poll fallback).
    @Query('afterMessageId', new ParseQueryStringPipe('afterMessageId', 100)) afterMessageId?: string,
  ): Promise<object> {
    const excludeIds = excludeIdsRaw
      ? excludeIdsRaw.split(',').map(id => id.trim()).filter(id => id.length > 0 && id.length <= 30).slice(0, 200)
      : undefined;
    return this.chatService.getMessages(userId, roomId, cursor, limit, excludeIds, afterMessageId);
  }

  // ============================================================
  // Batch 43 BE-CHAT
  // ============================================================

  @Post('rooms/:roomId/messages/:messageId/translate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Translate a chat message to the target language' })
  async translateMessage(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Param('messageId', ParseIdPipe) messageId: string,
    @Body() dto: TranslateMessageDto,
  ): Promise<object> {
    return this.chatService.translateMessage(userId, messageId, dto.targetLang);
  }

  @Get('rooms/:roomId/export')
  @ApiOperation({ summary: 'Export chat history (txt or json). Room members only.' })
  async exportRoom(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Query('format', new DefaultValuePipe('txt'), new ParseQueryStringPipe('format', 10)) format: string,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const normalized = format.toLowerCase();
    if (normalized !== 'txt' && normalized !== 'json') {
      throw new BadRequestException('format must be txt or json');
    }
    const result = await this.chatService.exportRoom(userId, roomId, normalized);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    if (result.format === 'json') {
      res.type('application/json').send(JSON.stringify(result.content, null, 2));
    } else {
      res.type('text/plain; charset=utf-8').send(result.content as string);
    }
  }

  @Get('privacy')
  @ApiOperation({ summary: 'Get chat privacy settings (read receipts, DM policy)' })
  async getChatPrivacy(@CurrentUser('sub') userId: string): Promise<object> {
    return this.chatService.getChatPrivacy(userId);
  }

  @Patch('privacy')
  @ApiOperation({ summary: 'Update chat privacy settings' })
  async updateChatPrivacy(
    @CurrentUser('sub') userId: string,
    @Body() dto: UpdateChatPrivacyDto,
  ): Promise<object> {
    return this.chatService.updateChatPrivacy(userId, dto);
  }

  @Get('rooms/:roomId/starred')
  @ApiOperation({ summary: 'List starred messages in a room' })
  async listStarredMessages(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
  ): Promise<object> {
    return this.chatService.listStarredMessages(userId, roomId);
  }

  @Post('rooms/:roomId/starred/:messageId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Star a message' })
  async starMessage(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Param('messageId', ParseIdPipe) messageId: string,
  ): Promise<object> {
    return this.chatService.starMessage(userId, roomId, messageId);
  }

  @Delete('rooms/:roomId/starred/:messageId')
  @ApiOperation({ summary: 'Unstar a message' })
  async unstarMessage(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Param('messageId', ParseIdPipe) messageId: string,
  ): Promise<object> {
    return this.chatService.unstarMessage(userId, roomId, messageId);
  }

  @Post('self')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get or create the self-chat room (saved messages)' })
  async getOrCreateSelfRoom(@CurrentUser('sub') userId: string): Promise<object> {
    return this.chatService.getOrCreateSelfRoom(userId);
  }

  @Get('rooms/:roomId/polls')
  @ApiOperation({ summary: 'List polls in a chat room' })
  async listPolls(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
  ): Promise<object> {
    return this.chatService.listPolls(userId, roomId);
  }

  @Post('rooms/:roomId/polls')
  @ApiOperation({ summary: 'Create a poll in a chat room' })
  async createPoll(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Body() dto: CreatePollDto,
  ): Promise<object> {
    return this.chatService.createPoll(userId, roomId, dto);
  }

  @Get('rooms/:roomId/polls/:pollId')
  @ApiOperation({ summary: 'Get poll detail with results' })
  async getPoll(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Param('pollId', ParseIdPipe) pollId: string,
  ): Promise<object> {
    return this.chatService.getPoll(userId, roomId, pollId);
  }

  @Post('rooms/:roomId/polls/:pollId/vote')
  @ApiOperation({ summary: 'Vote on a poll' })
  async votePoll(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Param('pollId', ParseIdPipe) pollId: string,
    @Body() dto: VotePollDto,
  ): Promise<object> {
    return this.chatService.votePoll(userId, roomId, pollId, dto.optionIndexes);
  }

  @Post('rooms/:roomId/polls/:pollId/close')
  @HttpCode(200)
  @ApiOperation({ summary: 'Close a poll (creator only)' })
  async closePoll(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Param('pollId', ParseIdPipe) pollId: string,
  ): Promise<object> {
    return this.chatService.closePoll(userId, roomId, pollId);
  }

  @Get('pinned')
  @ApiOperation({ summary: 'List pinned chat rooms (synced across devices)' })
  async listPinnedChatRooms(@CurrentUser('sub') userId: string): Promise<object> {
    return this.chatService.listPinnedChatRooms(userId);
  }

  @Post('rooms/:roomId/pin')
  @ApiOperation({ summary: 'Pin a chat room (backend-synced)' })
  async pinChatRoom(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Body() dto: PinChatRoomDto,
  ): Promise<object> {
    return this.chatService.pinChatRoom(userId, roomId, dto.position);
  }

  @Delete('rooms/:roomId/pin')
  @ApiOperation({ summary: 'Unpin a chat room' })
  async unpinChatRoom(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
  ): Promise<object> {
    return this.chatService.unpinChatRoom(userId, roomId);
  }

  @Get('reply-templates')
  @ApiOperation({ summary: 'List reply templates (synced across devices)' })
  async listReplyTemplates(@CurrentUser('sub') userId: string): Promise<object> {
    return this.chatService.listReplyTemplates(userId);
  }

  @Post('reply-templates')
  @ApiOperation({ summary: 'Create a reply template' })
  async createReplyTemplate(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateReplyTemplateDto,
  ): Promise<object> {
    return this.chatService.createReplyTemplate(userId, dto);
  }

  @Patch('reply-templates/:templateId')
  @ApiOperation({ summary: 'Update a reply template' })
  async updateReplyTemplate(
    @CurrentUser('sub') userId: string,
    @Param('templateId', ParseIdPipe) templateId: string,
    @Body() dto: UpdateReplyTemplateDto,
  ): Promise<object> {
    return this.chatService.updateReplyTemplate(userId, templateId, dto);
  }

  @Delete('reply-templates/:templateId')
  @ApiOperation({ summary: 'Delete a reply template' })
  async deleteReplyTemplate(
    @CurrentUser('sub') userId: string,
    @Param('templateId', ParseIdPipe) templateId: string,
  ): Promise<object> {
    return this.chatService.deleteReplyTemplate(userId, templateId);
  }

  @Post('rooms/:roomId/block')
  @HttpCode(200)
  @ApiOperation({ summary: 'Block the counterpart of this room (from room menu)' })
  async blockCounterpartFromRoom(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
  ): Promise<object> {
    return this.chatService.blockCounterpartFromRoom(userId, roomId);
  }

  @Post('rooms/:roomId/report')
  @ApiOperation({ summary: 'Report the counterpart of this room (from room menu)' })
  async reportCounterpartFromRoom(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Body() dto: ReportRoomDto,
  ): Promise<object> {
    return this.chatService.reportCounterpartFromRoom(userId, roomId, dto);
  }

  @Post('rooms/:roomId/order')
  // P1-4 (audit integrasi 2026-10-06): idempotensi WAJIB — endpoint membuat
  // escrow order; double-tap sebelum re-render bisa membuat dua order.
  @Idempotency()
  @ApiOperation({ summary: 'Create an escrow order from a negotiation chat (1-by-1)' })
  async createOrderFromChat(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Body() dto: CreateOrderFromChatDto,
  ): Promise<object> {
    return this.chatService.createOrderFromChat(userId, roomId, dto);
  }

  @Get('rooms/:roomId/search')
  @ApiOperation({ summary: 'Search messages inside one chat room' })
  async searchMessages(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Query('q', new ParseQueryStringPipe('q', 100)) q: string,
    @Query('cursor', new ParseQueryStringPipe('cursor', 100)) cursor?: string,
    @Query('limit', new DefaultValuePipe(20), new ClampLimitPipe(CHAT_SEARCH_MAX_LIMIT)) limit?: number,
  ): Promise<object> {
    return this.chatService.searchMessages(userId, roomId, q, { limit, cursor });
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Idempotency()
  @Post('rooms/:roomId/messages')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send a message in a chat room',
    description:
      'Message text is scanned for off-platform circumvention (phone numbers, WhatsApp/Telegram links, "let\'s continue outside the app"). Blocking violations return HTTP 400 with code CHAT_MESSAGE_BLOCKED.',
  })
  async sendMessage(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Body() dto: SendMessageDto,
  ): Promise<object> {
    return this.chatService.sendMessage(userId, roomId, dto);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Patch('rooms/:roomId/messages/:messageId')
  @ApiOperation({
    summary: 'Edit own text message',
    description: 'The previous content is preserved in the message revision history, so edits never destroy dispute evidence. Blocked while the order is DISPUTED.',
  })
  async editMessage(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Param('messageId', ParseIdPipe) messageId: string,
    @Body() dto: EditMessageDto,
  ): Promise<object> {
    return this.chatService.editMessage(userId, roomId, messageId, dto.content);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Delete('rooms/:roomId/messages/:messageId')
  @ApiOperation({
    summary: 'Delete own message in a chat room',
    description:
      'Soft delete. The original content is retained for audit and for dispute resolvers. Deletion is refused while the order is DISPUTED (code CHAT_MESSAGE_LOCKED_DISPUTE).',
  })
  async deleteMessage(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Param('messageId', ParseIdPipe) messageId: string,
  ): Promise<{ message: string }> {
    return this.chatService.deleteMessage(userId, roomId, messageId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 10000, limit: 10 } })
  @Post('rooms/:roomId/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark messages as read in a chat room' })
  async markAsRead(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
  ): Promise<{ markedCount: number }> {
    return this.chatService.markAsRead(userId, roomId);
  }

  // ------------------------------------------------------------
  // Reactions
  // ------------------------------------------------------------

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Post('rooms/:roomId/messages/:messageId/reactions')
  @HttpCode(200)
  @ApiOperation({ summary: 'Add an emoji reaction to a message' })
  async addReaction(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Param('messageId', ParseIdPipe) messageId: string,
    @Body() dto: AddReactionDto,
  ): Promise<object> {
    return this.chatService.addReaction(userId, roomId, messageId, dto.emoji);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Delete('rooms/:roomId/messages/:messageId/reactions/:emoji')
  @ApiOperation({ summary: 'Remove an emoji reaction from a message' })
  async removeReaction(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Param('messageId', ParseIdPipe) messageId: string,
    @Param('emoji') emoji: string,
  ): Promise<object> {
    let decoded = emoji;
    try {
      decoded = decodeURIComponent(emoji);
    } catch {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Invalid emoji parameter' });
    }
    return this.chatService.removeReaction(userId, roomId, messageId, decoded);
  }

  // ------------------------------------------------------------
  // Pin & forward
  // ------------------------------------------------------------

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('rooms/:roomId/messages/:messageId/pin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Pin a message (e.g. shipping address or tracking number)' })
  async pinMessage(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Param('messageId', ParseIdPipe) messageId: string,
  ): Promise<object> {
    return this.chatService.pinMessage(userId, roomId, messageId, true);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Delete('rooms/:roomId/messages/:messageId/pin')
  @ApiOperation({ summary: 'Unpin a message' })
  async unpinMessage(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Param('messageId', ParseIdPipe) messageId: string,
  ): Promise<object> {
    return this.chatService.pinMessage(userId, roomId, messageId, false);
  }

  @Get('rooms/:roomId/pins')
  @ApiOperation({ summary: 'List pinned messages in a chat room' })
  async listPinnedMessages(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
  ): Promise<object> {
    return this.chatService.listPinnedMessages(userId, roomId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Idempotency()
  @Post('rooms/:roomId/messages/:messageId/forward')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Forward a message to other conversations',
    description: 'Only allowed between rooms that share the same counterpart, so private details never leak across transactions.',
  })
  async forwardMessage(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Param('messageId', ParseIdPipe) messageId: string,
    @Body() dto: ForwardMessageDto,
  ): Promise<object> {
    return this.chatService.forwardMessage(userId, roomId, messageId, dto.targetRoomIds);
  }

  // ------------------------------------------------------------
  // Room state: archive & mute (per user)
  // ------------------------------------------------------------

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Put('rooms/:roomId/archive')
  @ApiOperation({ summary: 'Archive or unarchive a conversation for the current user' })
  async setArchived(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Body() dto: ArchiveRoomDto,
  ): Promise<object> {
    return this.chatService.setRoomArchived(userId, roomId, dto.archived !== false);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Put('rooms/:roomId/mute')
  @ApiOperation({ summary: 'Mute or unmute a conversation for the current user' })
  async setMuted(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Body() dto: MuteRoomDto,
  ): Promise<object> {
    return this.chatService.setRoomMuted(userId, roomId, dto.muted !== false, dto.durationHours);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Delete('rooms/:roomId')
  @ApiOperation({
    summary: 'Delete a chat room (one by one, no bulk)',
    description:
      'Hapus 1-by-1, TANPA bulk. Hanya anggota room. ' +
      'DM/INQUIRY tanpa transaksi: dihapus PERMANEN (hard delete — pesan & keanggotaan ikut terhapus). ' +
      'Room ORDER (terikat transaksi): HANYA bila order sudah terminal COMPLETED, dan itu pun soft-delete ' +
      '(riwayat percakapan dipertahankan untuk audit). Order belum COMPLETED → 409 CHAT_ROOM_DELETE_ORDER_NOT_COMPLETED.',
  })
  async deleteRoom(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
  ): Promise<object> {
    return this.chatService.deleteRoom(userId, roomId);
  }

  @Get('rooms/:roomId/presence')
  @ApiOperation({
    summary: 'Online / last-seen status of the counterpart',
    description: 'Returns isOnline=false and lastSeenAt=null when the counterpart has disabled online status in privacy settings.',
  })
  async getRoomPresence(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
  ): Promise<object> {
    return this.chatService.getRoomPresence(userId, roomId);
  }

  // ------------------------------------------------------------
  // Attachments
  // ------------------------------------------------------------

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Idempotency()
  @Post('rooms/:roomId/upload')
  @HttpCode(200)
  @ApiOperation({ summary: 'Upload a file attachment to a chat room' })
  @ApiConsumes('multipart/form-data')
  // UPV-02: 413 multer mentah (LIMIT_FILE_SIZE) → `{ code: 'PAYLOAD_TOO_LARGE' }`
  // terstruktur, sama seperti di UploadController. Urutan di SATU decorator:
  // MulterTooLargeInterceptor HARUS outermost (index 0) agar catchError-nya
  // membungkus FileInterceptor yang melempar 413.
  @UseInterceptors(
    MulterTooLargeInterceptor,
    FileInterceptor('file', { limits: { fileSize: CHAT_ATTACHMENT_MAX_BYTES } }),
  )
  async uploadChatFile(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @UploadedFile() file: MulterFile,
  ): Promise<{ url: string; fileUrl: string; fileKey: string; fileName: string; mimeType: string; thumbnailFileKey?: string; thumbnailUrl?: string }> {
    if (!file) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'File is required' });
    }
    await this.chatService.validateRoomAccess(userId, roomId);
    const result = await this.uploadService.uploadDirect(
      userId,
      UploadPurpose.CHAT_ATTACHMENT,
      file.originalname,
      file.mimetype,
      file.buffer,
    );
    // Chat attachments are private. uploadDirect() already returns a short-lived
    // signed URL for private purposes (Batch 1A: ST-004) — use it directly
    // for immediate preview. The client may send this signed URL (or the
    // fileKey) in sendMessage; ChatService normalizes it to a stable storage
    // URL before persisting and re-signs at read time.
    // (Sebelumnya: fileUrl berupa URL publik permanen, sehingga controller ini
    // memanggil ulang generateDownloadUrl().)
    const readableUrl = result.fileUrl;
    // BFI-096 (audit integrasi 2026-09-30): FE mewajibkan `fileName`
    // (parseChatUploadResponse → ChatAttachmentDto). Aditif — field lama
    // tidak berubah. Nama diambil dari originalname; fallback ke segmen
    // terakhir fileKey (sudah disanitasi server-side saat upload).
    const fileName =
      (typeof file.originalname === 'string' && file.originalname.trim()) ||
      result.fileKey.split('/').pop() ||
      'file';
    // UPV-07: teruskan thumbnail video (best-effort, undefined bila gagal) —
    // FE sudah me-render `thumbnailUrl` bila ada (fallback ikon).
    return {
      url: readableUrl,
      fileUrl: readableUrl,
      fileKey: result.fileKey,
      fileName,
      mimeType: file.mimetype,
      thumbnailFileKey: result.thumbnailFileKey,
      thumbnailUrl: result.thumbnailUrl,
    };
  }

  @Get('rooms/:roomId/attachments')
  @ApiOperation({ summary: 'List room attachments' })
  async getRoomAttachments(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
  ): Promise<object> {
    return this.chatService.getRoomAttachments(userId, roomId, page, limit);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 10000, limit: 30 } })
  @Post('rooms/:roomId/typing')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send typing indicator (16.1)' })
  async typing(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Body() dto: { isTyping: boolean },
  ): Promise<{ sent: boolean }> {
    return this.chatService.sendTypingIndicator(userId, roomId, dto.isTyping);
  }

  @Get('rooms/:roomId/read-receipts')
  @ApiOperation({ summary: 'Get read receipts for room (16.2)' })
  async readReceipts(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
  ): Promise<object> {
    return this.chatService.getReadReceipts(userId, roomId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 10000, limit: 20 } })
  @Post('rooms/:roomId/messages/:messageId/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark single message as read (16.2)' })
  async markMessageRead(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Param('messageId', ParseIdPipe) messageId: string,
  ): Promise<object> {
    return this.chatService.markMessageAsRead(userId, roomId, messageId);
  }
}
