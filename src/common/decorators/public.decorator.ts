import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): ReturnType<typeof SetMetadata> => SetMetadata(IS_PUBLIC_KEY, true);

export const IS_ADMIN_ROUTE_KEY = 'isAdminRoute';
export const AdminRoute = (): ReturnType<typeof SetMetadata> => SetMetadata(IS_ADMIN_ROUTE_KEY, true);
