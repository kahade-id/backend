import { Controller, Get, Post, Patch, Put, Delete, Body, Param, Query, DefaultValuePipe, ParseIntPipe, ParseBoolPipe, HttpCode, UseGuards, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ClampLimitPipe } from '../../common/pipes/clamp-limit.pipe';
import { ParseQueryStringPipe } from '../../common/pipes/parse-query-string.pipe';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { ChatService } from './chat.service';
import { UploadService } from '../upload/upload.service';
import { UploadPurpose } from '../upload/dto/presigned-url.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotency } from '../../common/decorators/idempotency.decorator';
import { SendMessageDto } from './dto/send-message.dto';
import { EditMessageDto } from './dto/edit-message.dto';
import { AddReactionDto } from './dto/reaction.dto';
import { ForwardMessageDto } from './dto/forward-message.dto';
import { ArchiveRoomDto, MuteRoomDto } from './dto/room-state.dto';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import { PhoneVerifiedGuard } from '../../common/guards/phone-verified.guard';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import {
  CHAT_SEARCH_MAX_LIMIT,
  CHAT_SEARCH_MIN_QUERY_LENGTH,
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

  @Get('rooms')
  @ApiOperation({
    summary: 'List chat rooms for current user',
    description: 'Includes ORDER rooms and pre-transaction INQUIRY rooms. Archived rooms are hidden unless `archived=true`.',
  })
  async getRooms(
    @CurrentUser('sub') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
    @Query('type') type?: string,
    @Query('archived', new DefaultValuePipe(false), ParseBoolPipe) archived?: boolean,
  ): Promise<object> {
    const normalizedType = type === 'INQUIRY' ? 'INQUIRY' : type === 'ORDER' ? 'ORDER' : undefined;
    return this.chatService.getRooms(userId, { page, limit, type: normalizedType, archived });
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
  ): Promise<object> {
    const excludeIds = excludeIdsRaw
      ? excludeIdsRaw.split(',').map(id => id.trim()).filter(id => id.length > 0 && id.length <= 30).slice(0, 200)
      : undefined;
    return this.chatService.getMessages(userId, roomId, cursor, limit, excludeIds);
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
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async uploadChatFile(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @UploadedFile() file: MulterFile,
  ): Promise<{ url: string; fileUrl: string }> {
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
    // Chat attachments are stored in the private bucket. Return a short-lived
    // read URL, not the internal object key (which is neither HTTPS nor readable
    // by the mobile image component and was later rejected by SendMessageDto).
    const readableUrl = result.fileUrl.startsWith('https://')
      ? result.fileUrl
      : await this.uploadService.generateDownloadUrl(result.fileKey, 900);
    return { url: readableUrl, fileUrl: readableUrl };
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
}
