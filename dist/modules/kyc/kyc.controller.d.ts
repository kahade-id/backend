import { KycService } from './kyc.service';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { PaginationDto, PaginatedResponse } from '../../common/dto/pagination.dto';
import { Request } from 'express';
export declare class KycController {
    private readonly kycService;
    constructor(kycService: KycService);
    submit(userId: string, dto: SubmitKycDto, req: Request): Promise<Record<string, unknown>>;
    getStatus(userId: string): Promise<Record<string, unknown>>;
    getHistory(userId: string, pagination: PaginationDto): Promise<PaginatedResponse<Record<string, unknown>>>;
    resubmit(userId: string, dto: SubmitKycDto, req: Request): Promise<Record<string, unknown>>;
    private validateKycFileOwnership;
}
