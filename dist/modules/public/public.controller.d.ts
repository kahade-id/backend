import { PublicService } from './public.service';
export declare class PublicController {
    private publicService;
    constructor(publicService: PublicService);
    getPublicConfigs(): Promise<{
        configs: Array<{
            key: string;
            value: string;
            description: string | null;
            dataType: string;
            updatedAt: Date;
        }>;
    }>;
    getFeeSchedule(): Record<string, unknown>;
    getBanks(): {
        banks: Array<{
            code: string;
            name: string;
        }>;
    };
    getSubscriptionPlans(): Promise<Record<string, unknown>>;
    getExchangeRates(): Promise<Record<string, unknown>>;
    getAppVersion(): Record<string, unknown>;
}
