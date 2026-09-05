import { GenderDto } from './register.dto';
export declare class PhoneRegisterDto {
    tempToken: string;
    fullName: string;
    username: string;
    dateOfBirth: string;
    gender: GenderDto;
    email: string;
    password: string;
    pin: string;
    address?: string;
    referralCode?: string;
    deviceId: string;
}
