import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { Prisma } from '@prisma/client';

@Catch(
  Prisma.PrismaClientKnownRequestError,
  Prisma.PrismaClientUnknownRequestError,
  Prisma.PrismaClientInitializationError,
  Prisma.PrismaClientRustPanicError,
)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  private static readonly PG_SERIALIZATION_FAILURE = '40001';
  private static readonly PG_DEADLOCK = '40P01';
  private static readonly PG_CHECK_VIOLATION = '23514';
  private static readonly PG_NUMERIC_OUT_OF_RANGE = '22003';
  private static readonly PG_NOT_NULL_VIOLATION = '23502';

  private extractPgCode(message: string): string | null {
    const codeMatch = message.match(/code:\s*"?(\w+)"?/i)
      ?? message.match(/SQLSTATE\[(\w+)\]/i)
      ?? message.match(/error code[:\s]+(\w+)/i);
    return codeMatch?.[1] ?? null;
  }

  catch(
    exception:
      | Prisma.PrismaClientKnownRequestError
      | Prisma.PrismaClientUnknownRequestError
      | Prisma.PrismaClientInitializationError
      | Prisma.PrismaClientRustPanicError,
    host: ArgumentsHost,
  ): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const requestId = response.get('X-Request-ID');

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'Database error occurred';

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          status = HttpStatus.CONFLICT;
          code = 'DUPLICATE_ENTRY';
          message = 'This value already exists. Please use a different one.';
          break;
        case 'P2025':
          status = HttpStatus.NOT_FOUND;
          code = 'NOT_FOUND';
          message = 'Record not found';
          break;
        case 'P2003':
          status = HttpStatus.BAD_REQUEST;
          code = 'FOREIGN_KEY_VIOLATION';
          message = 'Foreign key constraint violation';
          break;
        case 'P2004':
          status = HttpStatus.BAD_REQUEST;
          code = 'CONSTRAINT_VIOLATION';
          message = 'Constraint violation';
          break;
        case 'P2014':
          status = HttpStatus.BAD_REQUEST;
          code = 'INVALID_RELATION';
          message = 'Invalid relation';
          break;
        case 'P2034':
          status = HttpStatus.CONFLICT;
          code = 'TRANSACTION_CONFLICT';
          message = 'Transaction conflict. Please try again.';
          break;
        default:
          status = HttpStatus.INTERNAL_SERVER_ERROR;
          code = 'DATABASE_ERROR';
          message = 'An unexpected database error occurred';
          this.logger.error(`Unhandled Prisma error code: ${exception.code}`, exception.message);
      }
    } else if (exception instanceof Prisma.PrismaClientInitializationError) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      code = 'DATABASE_UNAVAILABLE';
      message = 'Database connection failed. Please try again later.';
      this.logger.error('PrismaClientInitializationError', exception.message);
    } else if (exception instanceof Prisma.PrismaClientRustPanicError) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      code = 'DATABASE_ENGINE_ERROR';
      message = 'An internal database error occurred. Please try again.';
      this.logger.error('PrismaClientRustPanicError', exception.message);
    } else {
      const errMsg = (exception as Prisma.PrismaClientUnknownRequestError).message;
      const pgCode = this.extractPgCode(errMsg);

      this.logger.error(
        `PrismaClientUnknownRequestError [pgCode=${pgCode ?? 'unknown'}]`,
        errMsg,
      );

      if (pgCode === PrismaExceptionFilter.PG_SERIALIZATION_FAILURE || pgCode === PrismaExceptionFilter.PG_DEADLOCK) {
        status = HttpStatus.CONFLICT;
        code = 'TRANSACTION_CONFLICT';
        message = 'Transaction conflict. Please try again.';
      } else if (pgCode === PrismaExceptionFilter.PG_CHECK_VIOLATION) {
        status = HttpStatus.BAD_REQUEST;
        code = 'CONSTRAINT_VIOLATION';
        const constraintMatch = errMsg.match(/constraint\s+"?(\w+)"?/i);
        const constraintName = constraintMatch?.[1];
        if (constraintName?.includes('balance')) {
          message = 'Insufficient balance for this operation.';
        } else {
          message = 'Data validation failed. Please check your input.';
        }
        this.logger.warn(`CHECK constraint violation: ${constraintName ?? 'unknown'}`, errMsg);
      } else if (pgCode === PrismaExceptionFilter.PG_NOT_NULL_VIOLATION) {
        status = HttpStatus.BAD_REQUEST;
        code = 'MISSING_REQUIRED_FIELD';
        message = 'A required field is missing.';
      } else if (pgCode === PrismaExceptionFilter.PG_NUMERIC_OUT_OF_RANGE) {
        status = HttpStatus.BAD_REQUEST;
        code = 'AMOUNT_OUT_OF_RANGE';
        message = 'The amount is out of the allowed range.';
      } else {
        status = HttpStatus.INTERNAL_SERVER_ERROR;
        code = 'DATABASE_UNKNOWN_ERROR';
        message = 'An unexpected database error occurred. Please try again.';
      }
    }

    response.status(status).json({
      success: false,
      message,
      data: null,
      errors: { code, requestId },
    });
  }
}
