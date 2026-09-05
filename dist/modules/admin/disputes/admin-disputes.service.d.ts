import { PrismaService } from '../../../prisma/prisma.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { DisputeDecisionDto } from './dispute-decision.dto';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { UploadService } from '../../upload/upload.service';
import { RealtimeService } from '../../realtime/realtime.service';
export declare class AdminDisputesService {
    private prisma;
    private walletTxSerialService;
    private auditLog;
    private uploadService;
    private realtime;
    private readonly logger;
    constructor(prisma: PrismaService, walletTxSerialService: WalletTxSerialService, auditLog: AuditLogService, uploadService: UploadService, realtime: RealtimeService);
    private withSerializableRetry;
    listDisputes(page?: number, limit?: number, status?: string, search?: string): Promise<object>;
    getDisputeDetail(disputeId: string, adminId?: string, ipAddress?: string): Promise<object>;
    resolveDispute(disputeId: string, adminId: string, dto: DisputeDecisionDto, ipAddress?: string): Promise<object>;
    assignAdmin(disputeId: string, requestingAdminId: string, targetAdminId?: string, _ipAddress?: string): Promise<object>;
    getDisputeMessages(disputeId: string, adminId: string, cursor?: string, limit?: number): Promise<object>;
    markUnderReview(disputeId: string, adminId: string, ipAddress?: string): Promise<object>;
    sendDisputeMessage(disputeId: string, adminId: string, content: string, ipAddress?: string): Promise<object>;
}
