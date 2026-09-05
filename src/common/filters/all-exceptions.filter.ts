import * as Sentry from '@sentry/nestjs';
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  Inject,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response, Request } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = response.get('X-Request-ID');

    const expressStatus = (exception as { statusCode?: number })?.statusCode;
    const expressType = (exception as { type?: string })?.type;
    if (expressStatus && expressStatus >= 400 && expressStatus < 500 && expressType) {
      let code: string;
      let message: string;
      if (expressType === 'entity.too.large') {
        code = 'PAYLOAD_TOO_LARGE';
        message = 'Request body too large (max 100 KB)';
      } else if (expressType === 'entity.parse.failed') {
        code = 'BAD_REQUEST';
        message = 'Malformed request body';
      } else if (expressType === 'encoding.unsupported') {
        code = 'BAD_REQUEST';
        message = 'Unsupported content encoding';
      } else if (expressType === 'charset.unsupported') {
        code = 'BAD_REQUEST';
        message = 'Unsupported charset';
      } else if (expressType === 'parameters.too.many') {
        code = 'BAD_REQUEST';
        message = 'Too many parameters';
      } else {
        code = 'BAD_REQUEST';
        message = 'Bad request';
      }
      response.status(expressStatus).json({
        success: false,
        message,
        data: null,
        errors: { code, requestId },
      });
      return;
    }

    Sentry.withScope((scope) => {
      const sanitizedUrl = request.url?.split('?')[0] ?? request.url;
      scope.setExtra('url', sanitizedUrl);
      scope.setExtra('method', request.method);
      scope.setExtra('requestId', requestId);
      scope.setExtra('userId', (request as unknown as { user?: { sub?: string } }).user?.sub);
      Sentry.captureException(exception);
    });

    const isProduction = this.configService.get<string>('app.nodeEnv') === 'production';
    if (!isProduction) {
      this.logger.error(
        `Unhandled exception occurred: ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
        'AllExceptionsFilter',
      );
    } else {
      this.logger.error(
        `Unhandled exception: ${request.method} ${request.url} [${requestId}]`,
        exception instanceof Error ? exception.message : 'Unknown error',
      );
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: 'Internal server error',
      data: null,
      errors: {
        code: 'INTERNAL_SERVER_ERROR',
        requestId,
      },
    });
  }
}
