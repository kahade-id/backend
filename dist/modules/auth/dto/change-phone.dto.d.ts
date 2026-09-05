export declare class RequestPhoneChangeDto {
    newPhoneNumber: string;
    method: 'SMS' | 'WHATSAPP';
    currentPassword: string;
    mfaCode?: string;
}
export declare class ConfirmPhoneChangeDto {
    newPhoneNumber: string;
    code: string;
}
