import { FeeResponsibility } from '@prisma/client';
export declare class CalculateFeeDto {
    orderValue: number;
    feeResponsibility: FeeResponsibility;
    voucherCode?: string;
    role?: 'BUYER' | 'SELLER';
}
export declare class ConfirmOrderDto {
    action: 'ACCEPT' | 'REJECT';
    reason?: string;
}
export declare class UpdateShippingDto {
    trackingNumber?: string;
    courierName?: string;
    trackingNotes?: string;
}
export declare class RequestExtensionDto {
    extensionDays: number;
    reason: string;
}
export declare class RespondExtensionDto {
    action: 'APPROVE' | 'REJECT';
    note?: string;
}
export declare class CancelOrderDto {
    reason: string;
    note?: string;
}
export declare class SubmitDisputeDto {
    claim: string;
    fileUrls?: string[];
    fileTypes?: string[];
}
export declare class ValidateCounterpartDto {
    username: string;
}
export declare class PayOrderDto {
    pin: string;
}
