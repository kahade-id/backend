// GAP-F (G461): usage interceptor — records every partner API call into
// PartnerApiUsage (daily, per endpoint) with error counts.

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { PartnerRequestIdentity } from './partner.decorators';
import { PartnerUsageService } from './partner-usage.service';

@Injectable()
export class PartnerUsageInterceptor implements NestInterceptor {
  constructor(private readonly usage: PartnerUsageService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const partner = req.partner as PartnerRequestIdentity | undefined;
    if (!partner) return next.handle();

    const endpoint = `${req.method} ${req.route?.path ?? req.path}`;
    return next.handle().pipe(
      tap({
        next: () => {
          void this.usage.recordCall(partner.clientId, endpoint, true);
        },
        error: (err) => {
          void this.usage.recordCall(partner.clientId, endpoint, false);
        },
      }),
      catchError((err) => throwError(() => err)),
    );
  }
}
