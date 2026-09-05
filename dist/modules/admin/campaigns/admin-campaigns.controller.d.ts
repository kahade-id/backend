import { Request } from 'express';
import { CampaignService } from '../campaign.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
export declare class AdminCampaignsController {
    private campaignService;
    constructor(campaignService: CampaignService);
    createCampaign(adminId: string, dto: CreateCampaignDto, req: Request): Promise<object>;
    getCampaigns(page: number, limit: number, status?: string): Promise<object>;
    getCampaign(campaignId: string): Promise<object>;
    updateCampaign(adminId: string, campaignId: string, dto: UpdateCampaignDto, req: Request): Promise<object>;
    deleteCampaign(adminId: string, campaignId: string, req: Request): Promise<{
        message: string;
    }>;
}
