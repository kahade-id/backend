import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { UploadService } from '../upload/upload.service';
export declare class DisputeMessageService {
    private prisma;
    private realtime;
    private uploadService;
    private readonly logger;
    constructor(prisma: PrismaService, realtime: RealtimeService, uploadService: UploadService);
    private validateDisputeAccess;
    getMessages(disputeId: string, userId: string, page: number, limit: number): Promise<object>;
    sendMessage(disputeId: string, userId: string, message: string, attachments?: Array<{
        fileKey: string;
        fileName: string;
        fileType: string;
        fileSize: number;
    }>): Promise<object>;
    private cleanupConfirmedAttachments;
}
