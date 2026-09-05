import { ExceptionFilter, ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
export declare class PrismaExceptionFilter implements ExceptionFilter {
    private readonly logger;
    private static readonly PG_SERIALIZATION_FAILURE;
    private static readonly PG_DEADLOCK;
    private static readonly PG_CHECK_VIOLATION;
    private static readonly PG_NUMERIC_OUT_OF_RANGE;
    private static readonly PG_NOT_NULL_VIOLATION;
    private extractPgCode;
    catch(exception: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientUnknownRequestError | Prisma.PrismaClientInitializationError | Prisma.PrismaClientRustPanicError, host: ArgumentsHost): void;
}
