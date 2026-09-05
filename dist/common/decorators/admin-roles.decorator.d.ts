import { SetMetadata } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
export declare const ADMIN_ROLES_KEY = "adminRoles";
export declare const AdminRoles: (...roles: AdminRole[]) => ReturnType<typeof SetMetadata>;
