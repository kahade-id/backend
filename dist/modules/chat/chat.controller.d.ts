import { ChatService } from './chat.service';
import { UploadService } from '../upload/upload.service';
import { SendMessageDto } from './dto/send-message.dto';
interface MulterFile {
    fieldname: string;
    originalname: string;
    encoding: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
}
export declare class ChatController {
    private chatService;
    private uploadService;
    constructor(chatService: ChatService, uploadService: UploadService);
    getRooms(userId: string, page: number, limit: number): Promise<object>;
    getMessages(userId: string, roomId: string, cursor?: string, limit?: number, excludeIdsRaw?: string): Promise<object>;
    sendMessage(userId: string, roomId: string, dto: SendMessageDto): Promise<object>;
    markAsRead(userId: string, roomId: string): Promise<{
        markedCount: number;
    }>;
    deleteMessage(userId: string, roomId: string, messageId: string): Promise<{
        message: string;
    }>;
    uploadChatFile(userId: string, roomId: string, file: MulterFile): Promise<{
        url: string;
        fileUrl: string;
    }>;
    getRoomAttachments(userId: string, roomId: string, page: number, limit: number): Promise<object>;
}
export {};
