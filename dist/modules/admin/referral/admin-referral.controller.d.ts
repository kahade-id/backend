import { AdminReferralService } from './admin-referral.service';
import { ReferralCodeQueryDto } from './dto/referral-code-query.dto';
export declare class AdminReferralController {
    private readonly service;
    constructor(service: AdminReferralService);
    getReferralStats(): Promise<object>;
    listReferralCodes(query: ReferralCodeQueryDto): Promise<object>;
}
