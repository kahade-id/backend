"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoggingInterceptor = void 0;
const common_1 = require("@nestjs/common");
const operators_1 = require("rxjs/operators");
const rxjs_1 = require("rxjs");
const REDACT_FIELDS = new Set([
    'password', 'passwd', 'newPassword', 'confirmPassword', 'currentPassword', 'oldPassword',
    'pin', 'walletPin', 'walletPinHash', 'newPin', 'currentPin',
    'cardNumber', 'card_number', 'cvv', 'cvc', 'expiryDate',
    'token', 'accessToken', 'refreshToken', 'secret', 'apiKey', 'api_key', 'privateKey',
    'authorization', 'otp', 'otpCode', 'mfaCode', 'captchaAnswer',
    'backupCode', 'code', 'emailOtpCode',
    'accountNumber', 'account_number', 'accountName', 'beneficiaryAccount', 'beneficiaryName',
    'ktp', 'nik', 'idNumber', 'identityNumber',
    'phoneNumber', 'phone',
    'idempotencyKey', 'idempotency_key', 'csrfToken', 'csrf_token',
]);
function redactBody(body) {
    if (!body || typeof body !== 'object')
        return body;
    if (Array.isArray(body))
        return body.map(redactBody);
    const result = {};
    for (const [key, val] of Object.entries(body)) {
        if (REDACT_FIELDS.has(key)) {
            result[key] = '[REDACTED]';
        }
        else if (val && typeof val === 'object') {
            result[key] = redactBody(val);
        }
        else {
            result[key] = val;
        }
    }
    return result;
}
let LoggingInterceptor = class LoggingInterceptor {
    constructor() {
        this.logger = new common_1.Logger('HTTP');
    }
    intercept(context, next) {
        const ctx = context.switchToHttp();
        const req = ctx.getRequest();
        const res = ctx.getResponse();
        const { method, ip } = req;
        const safeUrl = req.path || req.url.split('?')[0];
        const requestId = req.requestId ?? req.headers['x-request-id'] ?? '-';
        const userId = req.user?.id ?? req.admin?.id ?? '-';
        const userAgent = String(req.headers['user-agent'] ?? '-').slice(0, 256).replace(/[\r\n\t]/g, ' ');
        const startTime = Date.now();
        if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
            this.logger.debug(`${method} ${safeUrl} body=${JSON.stringify(redactBody(req.body))}`);
        }
        return next.handle().pipe((0, operators_1.tap)(() => {
            const duration = Date.now() - startTime;
            const statusCode = res.statusCode;
            const logData = {
                requestId,
                userId,
                method,
                path: safeUrl,
                statusCode,
                duration,
                ip,
                userAgent,
            };
            this.logger.log(JSON.stringify(logData));
        }), (0, operators_1.catchError)((error) => {
            const duration = Date.now() - startTime;
            const statusCode = error?.status ?? 500;
            const logData = {
                requestId,
                userId,
                method,
                path: safeUrl,
                statusCode,
                duration,
                ip,
                error: error?.message ?? 'Unknown error',
            };
            if (statusCode >= 500) {
                this.logger.error(JSON.stringify(logData));
            }
            else {
                this.logger.warn(JSON.stringify(logData));
            }
            return (0, rxjs_1.throwError)(() => error);
        }));
    }
};
exports.LoggingInterceptor = LoggingInterceptor;
exports.LoggingInterceptor = LoggingInterceptor = __decorate([
    (0, common_1.Injectable)()
], LoggingInterceptor);
