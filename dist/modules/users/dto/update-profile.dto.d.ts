import { UserAccountType } from '@prisma/client';
export declare class UpdateProfileDto {
    fullName?: string;
    username?: string;
    bio?: string;
    accountType?: UserAccountType;
    phoneNumber?: string;
    dateOfBirth?: string;
    gender?: string;
    contactEmail?: string;
    contactPhone?: string;
    showContactEmail?: boolean;
    showContactPhone?: boolean;
    profileVisible?: boolean;
    showOnlineStatus?: boolean;
    currentPassword?: string;
}
