import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const requestId = response.get('X-Request-ID');
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    let errorCode: string;
    let message: string;
    let details: string[] | undefined;

    if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
      const resp = exceptionResponse as Record<string, unknown>;
      errorCode = (resp.code as string) || this.getDefaultErrorCode(status);

      if (Array.isArray(resp.message)) {
        message = (resp.message[0] as string) || this.getDefaultMessage(status);
        details = resp.message.length > 1 ? (resp.message as string[]) : undefined;
      } else {
        message = (resp.message as string) || this.getDefaultMessage(status);
      }
    } else if (typeof exceptionResponse === 'string') {
      errorCode = this.getDefaultErrorCode(status);
      message = exceptionResponse;
    } else {
      errorCode = this.getDefaultErrorCode(status);
      message = this.getDefaultMessage(status);
    }

    const errorBody: Record<string, unknown> = {
      code: errorCode,
      message,
    };
    if (details) {
      errorBody.details = details;
    }
    if (requestId) {
      errorBody.requestId = requestId;
    }

    response.status(status).json({
      success: false,
      message,
      data: null,
      errors: errorBody,
    });
  }

  private getDefaultErrorCode(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'BAD_REQUEST';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'UNPROCESSABLE_ENTITY';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMIT_EXCEEDED';
      case HttpStatus.INTERNAL_SERVER_ERROR:
        return 'INTERNAL_SERVER_ERROR';
      case HttpStatus.SERVICE_UNAVAILABLE:
        return 'SERVICE_UNAVAILABLE';
      default:
        return 'UNKNOWN_ERROR';
    }
  }

  private getDefaultMessage(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'Bad request';
      case HttpStatus.UNAUTHORIZED:
        return 'Unauthorized';
      case HttpStatus.FORBIDDEN:
        return 'Forbidden';
      case HttpStatus.NOT_FOUND:
        return 'Resource not found';
      case HttpStatus.CONFLICT:
        return 'Conflict';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'Unprocessable entity';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'Rate limit exceeded';
      case HttpStatus.INTERNAL_SERVER_ERROR:
        return 'Internal server error';
      case HttpStatus.SERVICE_UNAVAILABLE:
        return 'Service unavailable';
      default:
        return 'An error occurred';
    }
  }
}
