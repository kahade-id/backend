import { Controller, Get, Post, Delete, Body, Param, Query, DefaultValuePipe, ParseIntPipe, HttpCode, UseGuards, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
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
import { PhoneVerifiedGuard } from '../../common/guards/phone-verified.guard';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';

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
  @ApiOperation({ summary: 'List chat rooms for current user' })
  async getRooms(
    @CurrentUser('sub') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
  ): Promise<object> {
    return this.chatService.getRooms(userId, page, limit);
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

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Idempotency()
  @Post('rooms/:roomId/messages')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a message in a chat room' })
  async sendMessage(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Body() dto: SendMessageDto,
  ): Promise<object> {
    return this.chatService.sendMessage(userId, roomId, dto);
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

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Delete('rooms/:roomId/messages/:messageId')
  @ApiOperation({ summary: 'Delete own message in a chat room' })
  async deleteMessage(
    @CurrentUser('sub') userId: string,
    @Param('roomId', ParseIdPipe) roomId: string,
    @Param('messageId', ParseIdPipe) messageId: string,
  ): Promise<{ message: string }> {
    return this.chatService.deleteMessage(userId, roomId, messageId);
  }

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
