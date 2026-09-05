import { PrismaService } from '../../prisma/prisma.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { UploadService } from '../upload/upload.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { PaginatedResponse } from '../../common/dto/pagination.dto';
import { DisputeEvidence } from '@prisma/client';
import { SubmitEvidenceDto } from './dto/submit-evidence.dto';
import { SubmitClaimDto } from './dto/submit-claim.dto';
export declare class DisputesService {
    private prisma;
    private serialService;
    private uploadService;
    private auditLog;
    private readonly logger;
    constructor(prisma: PrismaService, serialService: WalletTxSerialService, uploadService: UploadService, auditLog: AuditLogService);
    private isRetryableDbError;
    private withSerializableRetry;
    private runRealtimeBestEffort;
    private cleanupEvidenceUploads;
    listMyDisputes(userId: string, page: number, limit: number): Promise<PaginatedResponse<Record<string, unknown>>>;
    listEvidence(disputeId: string, userId: string, page: number, limit: number): Promise<PaginatedResponse<DisputeEvidence>>;
    getDisputeDetail(disputeId: string, userId: string): Promise<Record<string, unknown>>;
    submitEvidence(disputeId: string, userId: string, dto: SubmitEvidenceDto): Promise<{
        evidence: DisputeEvidence | null;
        fileResults: {
            fileKey: string;
            fileType: string;
            status: 'ok' | 'error';
            error?: string;
        }[];
        summary: {
            total: number;
            succeeded: number;
            failed: number;
        };
    }>;
    deleteEvidence(disputeId: string, evidenceId: string, userId: string): Promise<{
        deleted: boolean;
    }>;
    submitClaim(disputeId: string, userId: string, dto: SubmitClaimDto): Promise<Record<string, unknown>>;
    submitDispute(orderId: string, userId: string, dto: {
        claim: string;
        fileUrls?: string[];
        fileTypes?: string[];
    }): Promise<{
        disputeId: string;
        status: string;
    }>;
    private runSubmitDisputeTx;
}
