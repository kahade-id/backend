import { ConfigService } from '@nestjs/config';
export type OtpDeliveryMethod = 'SMS' | 'WHATSAPP';
export type OtpProviderName = 'mock' | 'fonnte' | 'twilio';
export interface OtpDeliveryResult {
    success: boolean;
    messageId?: string;
    error?: string;
}
export declare class OtpGatewayService {
    private readonly config;
    private readonly logger;
    private readonly provider;
    private readonly providerName;
    constructor(config: ConfigService);
    private isProductionRuntime;
    sendOtp(phoneNumber: string, code: string, method: OtpDeliveryMethod): Promise<OtpDeliveryResult>;
    supportsMethod(method: OtpDeliveryMethod): boolean;
    getSupportedMethods(): OtpDeliveryMethod[];
    getProviderName(): OtpProviderName;
    private buildProvider;
}
