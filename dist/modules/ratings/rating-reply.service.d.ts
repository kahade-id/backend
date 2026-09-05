import { PrismaService } from '../../prisma/prisma.service';
export interface RatingReplyResponse {
    id: string;
    content: string;
    createdAt?: Date;
    updatedAt?: Date;
    userId: string;
    replierId: string;
}
export declare class RatingReplyService {
    private prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    createReply(userId: string, ratingId: string, content: string): Promise<RatingReplyResponse>;
    private readonly REPLY_EDIT_WINDOW_DAYS;
    updateReply(userId: string, replyId: string, content: string): Promise<RatingReplyResponse>;
    deleteReply(userId: string, replyId: string): Promise<{
        message: string;
    }>;
    private sendReplyNotification;
}
