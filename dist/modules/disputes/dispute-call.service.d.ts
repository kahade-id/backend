import { PrismaService } from '../../prisma/prisma.service';
export declare class DisputeCallService {
    private prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    private readonly TERMINAL_STATUSES;
    private validateDisputeAccess;
    requestCall(disputeId: string, userId: string): Promise<object>;
    acceptCall(disputeId: string, userId: string, callId: string): Promise<object>;
    rejectCall(disputeId: string, userId: string, callId: string): Promise<object>;
    endCall(disputeId: string, userId: string, callId: string): Promise<object>;
    getCallHistory(disputeId: string, userId: string, page?: number, limit?: number): Promise<object>;
}
