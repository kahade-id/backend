import { SetMetadata } from '@nestjs/common';
import { AdminRole } from '@prisma/client';

export const ADMIN_ROLES_KEY = 'adminRoles';
export const AdminRoles = (...roles: AdminRole[]): ReturnType<typeof SetMetadata> => SetMetadata(ADMIN_ROLES_KEY, roles);
