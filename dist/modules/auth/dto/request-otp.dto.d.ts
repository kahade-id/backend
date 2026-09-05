export declare enum OtpMethodDto {
    SMS = "SMS",
    WHATSAPP = "WHATSAPP"
}
export declare class RequestOtpDto {
    phoneNumber: string;
    method: OtpMethodDto;
    deviceId: string;
}
