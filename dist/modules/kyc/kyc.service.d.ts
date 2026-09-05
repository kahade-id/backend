import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { PaginatedResponse } from '../../common/dto/pagination.dto';
import { UploadService } from '../upload/upload.service';
export declare class KycService {
    private prisma;
    private serialService;
    private auditLog;
    private uploadService;
    constructor(prisma: PrismaService, serialService: WalletTxSerialService, auditLog: AuditLogService, uploadService: UploadService);
    private getNextKycSerial;
    private isRetryableDbError;
    private withSerializableRetry;
    private verifyKycFilesConfirmed;
    private canonicalizeLegacyNik;
    submit(userId: string, ktpFileKey: string, selfieFileKey: string, nik: string, ipAddress?: string): Promise<Record<string, unknown>>;
    getStatus(userId: string): Promise<Record<string, unknown>>;
    getHistory(userId: string, page: number, limit: number): Promise<PaginatedResponse<Record<string, unknown>>>;
    resubmit(userId: string, ktpFileKey: string, selfieFileKey: string, nik: string, ipAddress?: string): Promise<Record<string, unknown>>;
}
