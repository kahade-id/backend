export declare enum GenderDto {
    MALE = "MALE",
    FEMALE = "FEMALE",
    OTHER = "OTHER",
    PREFER_NOT_TO_SAY = "PREFER_NOT_TO_SAY"
}
export declare class RegisterDto {
    fullName: string;
    username?: string;
    email: string;
    password: string;
    confirmPassword: string;
    phoneNumber?: string;
    dateOfBirth?: string;
    gender?: GenderDto;
    referralCode?: string;
    captchaId?: string;
    captchaAnswer?: number;
}
