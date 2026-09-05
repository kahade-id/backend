import { Request } from 'express';
import { AdminKycService } from './admin-kyc.service';
import { KycQueueQueryDto } from './dto/kyc-queue-query.dto';
import { ReviewKycDto } from './dto/review-kyc.dto';
import { RejectKycDto } from './dto/reject-kyc.dto';
import { RevokeKycDto } from './dto/revoke-kyc.dto';
import { GetDocumentUrlsDto } from './dto/get-document-urls.dto';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
export declare class AdminKycController {
    private readonly service;
    constructor(service: AdminKycService);
    getQueue(query: KycQueueQueryDto): Promise<object>;
    getDetail(kycId: string, admin: AdminJwtPayload, req: Request): Promise<Record<string, unknown>>;
    getDocumentUrls(kycId: string, admin: AdminJwtPayload, req: Request, dto: GetDocumentUrlsDto): Promise<{
        ktpUrl: string | null;
        selfieUrl: string | null;
        partialErrors?: string[];
    }>;
    approve(kycId: string, dto: ReviewKycDto, admin: AdminJwtPayload, req: Request): Promise<Record<string, unknown>>;
    reject(kycId: string, dto: RejectKycDto, admin: AdminJwtPayload, req: Request): Promise<Record<string, unknown>>;
    revoke(kycId: string, dto: RevokeKycDto, admin: AdminJwtPayload, req: Request): Promise<Record<string, unknown>>;
}
