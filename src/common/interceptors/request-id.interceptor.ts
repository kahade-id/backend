import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { randomUUID } from 'crypto';
import { requestContext } from '../../prisma/prisma.service';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    const rawId = request.headers['x-request-id'];
    const requestId =
      typeof rawId === 'string' && UUID_V4_RE.test(rawId)
        ? rawId
        : randomUUID();

    request.requestId = requestId;
    response.setHeader('X-Request-ID', requestId);

    return new Observable((subscriber) => {
      requestContext.run({ requestId }, () => {
        next.handle().subscribe({
          next: (val) => subscriber.next(val),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
      });
    });
  }
}
