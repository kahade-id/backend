import { AdminRole } from '@prisma/client';
export declare class UpdateAdminDto {
    fullName?: string;
    role?: AdminRole;
    isActive?: boolean;
}
