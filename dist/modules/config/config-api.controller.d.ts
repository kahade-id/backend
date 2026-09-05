import { PublicService } from '../public/public.service';
export declare class ConfigApiController {
    private publicService;
    constructor(publicService: PublicService);
    getExchangeRates(): Promise<Record<string, unknown>>;
}
export declare class AppApiController {
    private publicService;
    constructor(publicService: PublicService);
    getAppVersion(): Record<string, unknown>;
}
