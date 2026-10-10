import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

@Injectable()
export class StoryMediaTooLargeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof PayloadTooLargeException) {
          const response = error.getResponse();
          const code =
            typeof response === 'object' && response !== null
              ? (response as Record<string, unknown>).code
              : undefined;
          if (code !== 'STORY_MEDIA_TOO_LARGE') {
            return throwError(
              () =>
                new PayloadTooLargeException({
                  code: 'STORY_MEDIA_TOO_LARGE',
                  message: 'Ukuran media story melebihi batas (foto maks 10 MB, video maks 50 MB).',
                }),
            );
          }
        }
        return throwError(() => error);
      }),
    );
  }
}
