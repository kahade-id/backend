import { CampaignStatus } from '@prisma/client';
export declare class UpdateCampaignDto {
    name?: string;
    description?: string;
    startsAt?: string;
    endsAt?: string;
    maxRedemptions?: number;
    status?: CampaignStatus;
    rolloutPercent?: number;
}
