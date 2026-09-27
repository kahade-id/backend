// GAP-F (G454): granular scope guard. Requires PartnerApiKeyGuard to run first.
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PARTNER_SCOPES_KEY, PartnerRequestIdentity } from './partner.decorators';

@Injectable()
export class PartnerScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PARTNER_SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const partner = req.partner as PartnerRequestIdentity | undefined;
    if (!partner) {
      throw new ForbiddenException({ code: 'PARTNER_FORBIDDEN', message: 'Konteks mitra tidak ditemukan' });
    }
    const missing = required.filter((s) => !partner.scopes.includes(s));
    if (missing.length > 0) {
      throw new ForbiddenException({
        code: 'PARTNER_SCOPE_DENIED',
        message: `Scope tidak mencukupi. Dibutuhkan: ${missing.join(', ')}`,
      });
    }
    return true;
  }
}
