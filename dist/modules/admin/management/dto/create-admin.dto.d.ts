import { AdminRole } from '@prisma/client';
export declare class CreateAdminDto {
    fullName: string;
    email: string;
    password: string;
    role: AdminRole;
}
