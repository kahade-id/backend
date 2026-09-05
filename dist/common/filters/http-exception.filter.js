"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpExceptionFilter = void 0;
const common_1 = require("@nestjs/common");
let HttpExceptionFilter = class HttpExceptionFilter {
    catch(exception, host) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse();
        const requestId = response.get('X-Request-ID');
        const status = exception.getStatus();
        const exceptionResponse = exception.getResponse();
        let errorCode;
        let message;
        let details;
        if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
            const resp = exceptionResponse;
            errorCode = resp.code || this.getDefaultErrorCode(status);
            if (Array.isArray(resp.message)) {
                message = resp.message[0] || this.getDefaultMessage(status);
                details = resp.message.length > 1 ? resp.message : undefined;
            }
            else {
                message = resp.message || this.getDefaultMessage(status);
            }
        }
        else if (typeof exceptionResponse === 'string') {
            errorCode = this.getDefaultErrorCode(status);
            message = exceptionResponse;
        }
        else {
            errorCode = this.getDefaultErrorCode(status);
            message = this.getDefaultMessage(status);
        }
        const errorBody = {
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
    getDefaultErrorCode(status) {
        switch (status) {
            case common_1.HttpStatus.BAD_REQUEST:
                return 'BAD_REQUEST';
            case common_1.HttpStatus.UNAUTHORIZED:
                return 'UNAUTHORIZED';
            case common_1.HttpStatus.FORBIDDEN:
                return 'FORBIDDEN';
            case common_1.HttpStatus.NOT_FOUND:
                return 'NOT_FOUND';
            case common_1.HttpStatus.CONFLICT:
                return 'CONFLICT';
            case common_1.HttpStatus.UNPROCESSABLE_ENTITY:
                return 'UNPROCESSABLE_ENTITY';
            case common_1.HttpStatus.TOO_MANY_REQUESTS:
                return 'RATE_LIMIT_EXCEEDED';
            case common_1.HttpStatus.INTERNAL_SERVER_ERROR:
                return 'INTERNAL_SERVER_ERROR';
            case common_1.HttpStatus.SERVICE_UNAVAILABLE:
                return 'SERVICE_UNAVAILABLE';
            default:
                return 'UNKNOWN_ERROR';
        }
    }
    getDefaultMessage(status) {
        switch (status) {
            case common_1.HttpStatus.BAD_REQUEST:
                return 'Bad request';
            case common_1.HttpStatus.UNAUTHORIZED:
                return 'Unauthorized';
            case common_1.HttpStatus.FORBIDDEN:
                return 'Forbidden';
            case common_1.HttpStatus.NOT_FOUND:
                return 'Resource not found';
            case common_1.HttpStatus.CONFLICT:
                return 'Conflict';
            case common_1.HttpStatus.UNPROCESSABLE_ENTITY:
                return 'Unprocessable entity';
            case common_1.HttpStatus.TOO_MANY_REQUESTS:
                return 'Rate limit exceeded';
            case common_1.HttpStatus.INTERNAL_SERVER_ERROR:
                return 'Internal server error';
            case common_1.HttpStatus.SERVICE_UNAVAILABLE:
                return 'Service unavailable';
            default:
                return 'An error occurred';
        }
    }
};
exports.HttpExceptionFilter = HttpExceptionFilter;
exports.HttpExceptionFilter = HttpExceptionFilter = __decorate([
    (0, common_1.Catch)(common_1.HttpException)
], HttpExceptionFilter);
