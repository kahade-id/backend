import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminRole } from '@prisma/client';
import { ADMIN_ROLES_KEY } from '../decorators/admin-roles.decorator';
import * as ErrorCodes from '../constants/error-codes';

@Injectable()
export class AdminRolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<AdminRole[]>(ADMIN_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'No roles configured for this endpoint — access denied (fail-closed)',
      });
    }

    const { admin } = context.switchToHttp().getRequest();
    
    if (!admin) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Admin authentication required',
      });
    }

    const hasRole = requiredRoles.includes(admin.role);
    
    if (!hasRole) {
      throw new ForbiddenException({
        code: ErrorCodes.INSUFFICIENT_ADMIN_ROLE,
        message: 'Insufficient admin role for this action',
      });
    }

    return true;
  }
}
