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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CsrfGuard = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const csrf_service_1 = require("../services/csrf.service");
const public_decorator_1 = require("../decorators/public.decorator");
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let CsrfGuard = class CsrfGuard {
    constructor(csrfService, reflector) {
        this.csrfService = csrfService;
        this.reflector = reflector;
    }
    async canActivate(context) {
        const request = context.switchToHttp().getRequest();
        const isPublic = this.reflector.getAllAndOverride(public_decorator_1.IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (isPublic) {
            return true;
        }
        if (!STATE_CHANGING_METHODS.has(request.method)) {
            return true;
        }
        const user = request.user;
        const hasBearerHeader = request.headers.authorization?.startsWith('Bearer ') && user?.sub;
        if (hasBearerHeader) {
            return true;
        }
        if (!user?.sub) {
            throw new common_1.ForbiddenException({
                code: 'CSRF_NO_AUTH',
                message: 'CSRF guard requires an authenticated user — ensure JwtAuthGuard runs before CsrfGuard',
            });
        }
        if (!user.jti) {
            throw new common_1.ForbiddenException({
                code: 'CSRF_VALIDATION_FAILED',
                message: 'Token missing jti claim — CSRF validation cannot proceed',
            });
        }
        const csrfToken = request.headers['x-csrf-token'];
        if (!csrfToken) {
            throw new common_1.ForbiddenException({
                code: 'CSRF_TOKEN_MISSING',
                message: 'CSRF token is required for state-changing requests',
            });
        }
        const valid = await this.csrfService.validateToken(user.sub, user.jti, csrfToken);
        if (!valid) {
            throw new common_1.ForbiddenException({
                code: 'CSRF_TOKEN_INVALID',
                message: 'CSRF token is invalid or expired',
            });
        }
        return true;
    }
};
exports.CsrfGuard = CsrfGuard;
exports.CsrfGuard = CsrfGuard = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [csrf_service_1.CsrfService,
        core_1.Reflector])
], CsrfGuard);
