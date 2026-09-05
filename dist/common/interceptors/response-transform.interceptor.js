"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var ResponseTransformInterceptor_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResponseTransformInterceptor = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const operators_1 = require("rxjs/operators");
const library_1 = require("@prisma/client/runtime/library");
const allow_response_fields_decorator_1 = require("../decorators/allow-response-fields.decorator");
const SENSITIVE_FIELDS = new Set([
    'password',
    'passwordHash',
    'walletPin',
    'walletPinHash',
    'ktpNumber',
    'ktpNumberHash',
    'accountNumber',
    'accountNumberHash',
    'otpSecret',
    'mfaSecret',
    'twoFactorSecret',
    'refreshToken',
    'secret',
    'backupCodes',
    'pushToken',
    'ktpPhotoUrl',
    'selfiePhotoUrl',
]);
let ResponseTransformInterceptor = ResponseTransformInterceptor_1 = class ResponseTransformInterceptor {
    constructor(reflector) {
        this.reflector = reflector;
    }
    intercept(context, next) {
        const allowedFields = this.reflector.get(allow_response_fields_decorator_1.ALLOW_RESPONSE_FIELDS_KEY, context.getHandler());
        const allowSet = allowedFields ? new Set(allowedFields) : null;
        return next.handle().pipe((0, operators_1.map)((data) => {
            const serializedData = this.serializeBigInt(data, allowSet);
            if (serializedData && typeof serializedData === 'object' && 'success' in serializedData) {
                return serializedData;
            }
            if (serializedData === null || serializedData === undefined) {
                return {
                    success: true,
                    message: 'Success',
                    data: null,
                    errors: null,
                };
            }
            if (typeof serializedData === 'string') {
                return {
                    success: true,
                    message: serializedData,
                    data: null,
                    errors: null,
                };
            }
            return {
                success: true,
                message: 'Success',
                data: serializedData,
                errors: null,
            };
        }));
    }
    serializeBigInt(data, allowSet, depth = 0) {
        if (data === null || data === undefined) {
            return data;
        }
        if (depth > ResponseTransformInterceptor_1.MAX_DEPTH) {
            return '[max depth]';
        }
        if (typeof data === 'bigint') {
            return data.toString();
        }
        if (data instanceof Date) {
            return Number.isNaN(data.getTime()) ? null : data.toISOString();
        }
        if (data instanceof library_1.Decimal) {
            return data.toNumber();
        }
        if (Array.isArray(data)) {
            return data.map(item => this.serializeBigInt(item, allowSet, depth + 1));
        }
        if (typeof data === 'object') {
            const serialized = {};
            for (const key in data) {
                if (Object.prototype.hasOwnProperty.call(data, key)) {
                    if (SENSITIVE_FIELDS.has(key) && (!allowSet || !allowSet.has(key)))
                        continue;
                    serialized[key] = this.serializeBigInt(data[key], allowSet, depth + 1);
                }
            }
            return serialized;
        }
        return data;
    }
};
exports.ResponseTransformInterceptor = ResponseTransformInterceptor;
ResponseTransformInterceptor.MAX_DEPTH = 12;
exports.ResponseTransformInterceptor = ResponseTransformInterceptor = ResponseTransformInterceptor_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [core_1.Reflector])
], ResponseTransformInterceptor);
