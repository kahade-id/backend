"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var AllExceptionsFilter_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AllExceptionsFilter = void 0;
const Sentry = __importStar(require("@sentry/nestjs"));
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
let AllExceptionsFilter = AllExceptionsFilter_1 = class AllExceptionsFilter {
    constructor(configService) {
        this.configService = configService;
        this.logger = new common_1.Logger(AllExceptionsFilter_1.name);
    }
    catch(exception, host) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse();
        const request = ctx.getRequest();
        const requestId = response.get('X-Request-ID');
        const expressStatus = exception?.statusCode;
        const expressType = exception?.type;
        if (expressStatus && expressStatus >= 400 && expressStatus < 500 && expressType) {
            let code;
            let message;
            if (expressType === 'entity.too.large') {
                code = 'PAYLOAD_TOO_LARGE';
                message = 'Request body too large (max 100 KB)';
            }
            else if (expressType === 'entity.parse.failed') {
                code = 'BAD_REQUEST';
                message = 'Malformed request body';
            }
            else if (expressType === 'encoding.unsupported') {
                code = 'BAD_REQUEST';
                message = 'Unsupported content encoding';
            }
            else if (expressType === 'charset.unsupported') {
                code = 'BAD_REQUEST';
                message = 'Unsupported charset';
            }
            else if (expressType === 'parameters.too.many') {
                code = 'BAD_REQUEST';
                message = 'Too many parameters';
            }
            else {
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
            scope.setExtra('userId', request.user?.sub);
            Sentry.captureException(exception);
        });
        const isProduction = this.configService.get('app.nodeEnv') === 'production';
        if (!isProduction) {
            this.logger.error(`Unhandled exception occurred: ${request.method} ${request.url}`, exception instanceof Error ? exception.stack : String(exception), 'AllExceptionsFilter');
        }
        else {
            this.logger.error(`Unhandled exception: ${request.method} ${request.url} [${requestId}]`, exception instanceof Error ? exception.message : 'Unknown error');
        }
        response.status(common_1.HttpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: 'Internal server error',
            data: null,
            errors: {
                code: 'INTERNAL_SERVER_ERROR',
                requestId,
            },
        });
    }
};
exports.AllExceptionsFilter = AllExceptionsFilter;
exports.AllExceptionsFilter = AllExceptionsFilter = AllExceptionsFilter_1 = __decorate([
    (0, common_1.Catch)(),
    __param(0, (0, common_1.Inject)(config_1.ConfigService)),
    __metadata("design:paramtypes", [config_1.ConfigService])
], AllExceptionsFilter);
