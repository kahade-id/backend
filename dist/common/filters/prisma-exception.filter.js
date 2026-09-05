"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var PrismaExceptionFilter_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaExceptionFilter = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
let PrismaExceptionFilter = PrismaExceptionFilter_1 = class PrismaExceptionFilter {
    constructor() {
        this.logger = new common_1.Logger(PrismaExceptionFilter_1.name);
    }
    extractPgCode(message) {
        const codeMatch = message.match(/code:\s*"?(\w+)"?/i)
            ?? message.match(/SQLSTATE\[(\w+)\]/i)
            ?? message.match(/error code[:\s]+(\w+)/i);
        return codeMatch?.[1] ?? null;
    }
    catch(exception, host) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse();
        const requestId = response.get('X-Request-ID');
        let status = common_1.HttpStatus.INTERNAL_SERVER_ERROR;
        let code = 'INTERNAL_SERVER_ERROR';
        let message = 'Database error occurred';
        if (exception instanceof client_1.Prisma.PrismaClientKnownRequestError) {
            switch (exception.code) {
                case 'P2002':
                    status = common_1.HttpStatus.CONFLICT;
                    code = 'DUPLICATE_ENTRY';
                    message = 'This value already exists. Please use a different one.';
                    break;
                case 'P2025':
                    status = common_1.HttpStatus.NOT_FOUND;
                    code = 'NOT_FOUND';
                    message = 'Record not found';
                    break;
                case 'P2003':
                    status = common_1.HttpStatus.BAD_REQUEST;
                    code = 'FOREIGN_KEY_VIOLATION';
                    message = 'Foreign key constraint violation';
                    break;
                case 'P2004':
                    status = common_1.HttpStatus.BAD_REQUEST;
                    code = 'CONSTRAINT_VIOLATION';
                    message = 'Constraint violation';
                    break;
                case 'P2014':
                    status = common_1.HttpStatus.BAD_REQUEST;
                    code = 'INVALID_RELATION';
                    message = 'Invalid relation';
                    break;
                case 'P2034':
                    status = common_1.HttpStatus.CONFLICT;
                    code = 'TRANSACTION_CONFLICT';
                    message = 'Transaction conflict. Please try again.';
                    break;
                default:
                    status = common_1.HttpStatus.INTERNAL_SERVER_ERROR;
                    code = 'DATABASE_ERROR';
                    message = 'An unexpected database error occurred';
                    this.logger.error(`Unhandled Prisma error code: ${exception.code}`, exception.message);
            }
        }
        else if (exception instanceof client_1.Prisma.PrismaClientInitializationError) {
            status = common_1.HttpStatus.SERVICE_UNAVAILABLE;
            code = 'DATABASE_UNAVAILABLE';
            message = 'Database connection failed. Please try again later.';
            this.logger.error('PrismaClientInitializationError', exception.message);
        }
        else if (exception instanceof client_1.Prisma.PrismaClientRustPanicError) {
            status = common_1.HttpStatus.INTERNAL_SERVER_ERROR;
            code = 'DATABASE_ENGINE_ERROR';
            message = 'An internal database error occurred. Please try again.';
            this.logger.error('PrismaClientRustPanicError', exception.message);
        }
        else {
            const errMsg = exception.message;
            const pgCode = this.extractPgCode(errMsg);
            this.logger.error(`PrismaClientUnknownRequestError [pgCode=${pgCode ?? 'unknown'}]`, errMsg);
            if (pgCode === PrismaExceptionFilter_1.PG_SERIALIZATION_FAILURE || pgCode === PrismaExceptionFilter_1.PG_DEADLOCK) {
                status = common_1.HttpStatus.CONFLICT;
                code = 'TRANSACTION_CONFLICT';
                message = 'Transaction conflict. Please try again.';
            }
            else if (pgCode === PrismaExceptionFilter_1.PG_CHECK_VIOLATION) {
                status = common_1.HttpStatus.BAD_REQUEST;
                code = 'CONSTRAINT_VIOLATION';
                const constraintMatch = errMsg.match(/constraint\s+"?(\w+)"?/i);
                const constraintName = constraintMatch?.[1];
                if (constraintName?.includes('balance')) {
                    message = 'Insufficient balance for this operation.';
                }
                else {
                    message = 'Data validation failed. Please check your input.';
                }
                this.logger.warn(`CHECK constraint violation: ${constraintName ?? 'unknown'}`, errMsg);
            }
            else if (pgCode === PrismaExceptionFilter_1.PG_NOT_NULL_VIOLATION) {
                status = common_1.HttpStatus.BAD_REQUEST;
                code = 'MISSING_REQUIRED_FIELD';
                message = 'A required field is missing.';
            }
            else if (pgCode === PrismaExceptionFilter_1.PG_NUMERIC_OUT_OF_RANGE) {
                status = common_1.HttpStatus.BAD_REQUEST;
                code = 'AMOUNT_OUT_OF_RANGE';
                message = 'The amount is out of the allowed range.';
            }
            else {
                status = common_1.HttpStatus.INTERNAL_SERVER_ERROR;
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
};
exports.PrismaExceptionFilter = PrismaExceptionFilter;
PrismaExceptionFilter.PG_SERIALIZATION_FAILURE = '40001';
PrismaExceptionFilter.PG_DEADLOCK = '40P01';
PrismaExceptionFilter.PG_CHECK_VIOLATION = '23514';
PrismaExceptionFilter.PG_NUMERIC_OUT_OF_RANGE = '22003';
PrismaExceptionFilter.PG_NOT_NULL_VIOLATION = '23502';
exports.PrismaExceptionFilter = PrismaExceptionFilter = PrismaExceptionFilter_1 = __decorate([
    (0, common_1.Catch)(client_1.Prisma.PrismaClientKnownRequestError, client_1.Prisma.PrismaClientUnknownRequestError, client_1.Prisma.PrismaClientInitializationError, client_1.Prisma.PrismaClientRustPanicError)
], PrismaExceptionFilter);
