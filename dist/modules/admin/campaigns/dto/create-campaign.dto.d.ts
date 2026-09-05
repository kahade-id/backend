import { CampaignType } from '@prisma/client';
export declare class CreateCampaignDto {
    name: string;
    description?: string;
    type: CampaignType;
    startsAt: string;
    endsAt: string;
    discountValue?: number;
    discountPercent?: number;
    maxDiscount?: number;
    freeTransactions?: number;
    targetAudience?: string;
    maxRedemptions?: number;
}
