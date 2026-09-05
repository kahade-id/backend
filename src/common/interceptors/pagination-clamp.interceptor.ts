import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class PaginationClampInterceptor implements NestInterceptor {
  private readonly maxLimit: number;

  constructor(maxLimit = 100) {
    this.maxLimit = maxLimit;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    const rawLimit = Number(req.query?.limit);
    if (!Number.isNaN(rawLimit) && rawLimit > this.maxLimit) {
      req.query.limit = String(this.maxLimit);
      res.setHeader('X-Pagination-Clamped', 'true');
      res.setHeader('X-Pagination-Max-Limit', String(this.maxLimit));
    }

    return next.handle();
  }
}
