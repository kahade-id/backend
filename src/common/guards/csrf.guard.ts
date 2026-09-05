import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { CsrfService } from '../services/csrf.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private csrfService: CsrfService,
    private reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    if (!STATE_CHANGING_METHODS.has(request.method)) {
      return true;
    }

    const user = request.user as { sub?: string; jti?: string } | undefined;

    // SEC-006: Bearer token requests skip CSRF validation. Bearer tokens are not
    // automatically attached by the browser (unlike cookies), so they are inherently
    // immune to CSRF attacks. Only cookie-authenticated state-changing requests
    // require CSRF token validation. This design follows OWASP guidance:
    // https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
    const hasBearerHeader = request.headers.authorization?.startsWith('Bearer ') && user?.sub;
    if (hasBearerHeader) {
      return true;
    }

    if (!user?.sub) {
      throw new ForbiddenException({
        code: 'CSRF_NO_AUTH',
        message: 'CSRF guard requires an authenticated user — ensure JwtAuthGuard runs before CsrfGuard',
      });
    }
    if (!user.jti) {
      throw new ForbiddenException({
        code: 'CSRF_VALIDATION_FAILED',
        message: 'Token missing jti claim — CSRF validation cannot proceed',
      });
    }

    const csrfToken = request.headers['x-csrf-token'] as string | undefined;
    if (!csrfToken) {
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_MISSING',
        message: 'CSRF token is required for state-changing requests',
      });
    }

    const valid = await this.csrfService.validateToken(user.sub, user.jti, csrfToken);

    if (!valid) {
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_INVALID',
        message: 'CSRF token is invalid or expired',
      });
    }

    return true;
  }
}
