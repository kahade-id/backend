import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { OrderStateService } from './order-state.service';
import { NotificationQueueService } from '../queue/notification-queue.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
export declare class DeliveryProofService {
    private prisma;
    private configService;
    private uploadService;
    private auditLog;
    private orderStateService;
    private notificationQueue;
    private serialService;
    private readonly logger;
    constructor(prisma: PrismaService, configService: ConfigService, uploadService: UploadService, auditLog: AuditLogService, orderStateService: OrderStateService, notificationQueue: NotificationQueueService, serialService: WalletTxSerialService);
    private isRetryableDbError;
    private withSerializableRetry;
    private runPostCommitBestEffort;
    private validateFileKeys;
    submitProof(orderId: string, userId: string, dto: {
        description: string;
        fileUrls?: string[];
        linkUrls?: string[];
    }): Promise<object>;
    getProofs(orderId: string, userId: string): Promise<object[]>;
    confirmDelivery(orderId: string, userId: string, proofId?: string): Promise<{
        message: string;
    }>;
    private static readonly MAX_REJECTION_COUNT;
    rejectDelivery(orderId: string, userId: string, note: string, proofId?: string): Promise<{
        message: string;
        escalatedToDispute?: boolean;
    }>;
}
