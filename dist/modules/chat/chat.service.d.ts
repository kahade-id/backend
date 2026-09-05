import { ConfigService } from '@nestjs/config';
import { UploadService } from '../upload/upload.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SendMessageDto } from './dto/send-message.dto';
export declare class ChatService {
    private prisma;
    private realtime;
    private configService;
    private uploadService?;
    private readonly logger;
    constructor(prisma: PrismaService, realtime: RealtimeService, configService: ConfigService, uploadService?: UploadService | undefined);
    getRooms(userId: string, page?: number, limit?: number): Promise<object>;
    getMessages(userId: string, roomId: string, cursor?: string, limit?: number, excludeIds?: string[]): Promise<object>;
    sendMessage(userId: string, roomId: string, dto: SendMessageDto): Promise<object>;
    markAsRead(userId: string, roomId: string): Promise<{
        markedCount: number;
    }>;
    deleteMessage(userId: string, roomId: string, messageId: string): Promise<{
        message: string;
    }>;
    private toReadableAttachmentUrl;
    getRoomAttachments(userId: string, roomId: string, page: number, limit: number): Promise<object>;
    validateRoomAccess(userId: string, roomId: string): Promise<object>;
    private validateCanSendMessage;
}
