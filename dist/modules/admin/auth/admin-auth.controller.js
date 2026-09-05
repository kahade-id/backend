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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminAuthController = void 0;
const common_1 = require("@nestjs/common");
const throttler_1 = require("@nestjs/throttler");
const swagger_1 = require("@nestjs/swagger");
const config_1 = require("@nestjs/config");
const admin_auth_service_1 = require("./admin-auth.service");
const admin_login_dto_1 = require("./dto/admin-login.dto");
const admin_verify_2fa_dto_1 = require("./dto/admin-verify-2fa.dto");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const current_admin_decorator_1 = require("../../../common/decorators/current-admin.decorator");
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const ErrorCodes = __importStar(require("../../../common/constants/error-codes"));
const user_throttle_guard_1 = require("../../../common/guards/user-throttle.guard");
const ADMIN_REFRESH_COOKIE = 'kahade_admin_refresh';
let AdminAuthController = class AdminAuthController {
    constructor(adminAuthService, configService) {
        this.adminAuthService = adminAuthService;
        this.configService = configService;
    }
    getRefreshCookiePath() {
        const prefix = this.configService.get('app.apiPrefix') || 'v1';
        return `/${prefix}/admin/auth`;
    }
    setRefreshCookie(res, token) {
        res.cookie(ADMIN_REFRESH_COOKIE, token, {
            httpOnly: true,
            secure: true,
            sameSite: 'strict',
            path: this.getRefreshCookiePath(),
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });
    }
    clearRefreshCookie(res) {
        res.clearCookie(ADMIN_REFRESH_COOKIE, { path: this.getRefreshCookiePath() });
    }
    async login(dto, req, res) {
        const ip = req.ip || 'unknown';
        const result = await this.adminAuthService.login(dto.email, dto.password, dto.totpToken, ip);
        if ('requiresMfa' in result)
            return result;
        this.setRefreshCookie(res, result.refreshToken);
        const { refreshToken: _rt, ...body } = result;
        return body;
    }
    async verify2fa(dto, req, res) {
        const ip = req.ip || 'unknown';
        const result = await this.adminAuthService.verifyAdmin2fa(dto.tempToken, dto.totpToken, ip);
        this.setRefreshCookie(res, result.refreshToken);
        const { refreshToken: _rt, ...body } = result;
        return body;
    }
    async refreshToken(req, res) {
        const refreshToken = req.cookies?.[ADMIN_REFRESH_COOKIE];
        if (!refreshToken) {
            this.clearRefreshCookie(res);
            throw new common_1.UnauthorizedException({ code: ErrorCodes.TOKEN_REQUIRED, message: 'Refresh token required' });
        }
        let result;
        try {
            result = await this.adminAuthService.refreshAdminToken(refreshToken);
        }
        catch (error) {
            this.clearRefreshCookie(res);
            throw error;
        }
        this.setRefreshCookie(res, result.refreshToken);
        return { accessToken: result.accessToken };
    }
    async logout(admin, req, res) {
        const refreshToken = req.cookies?.[ADMIN_REFRESH_COOKIE];
        this.clearRefreshCookie(res);
        return this.adminAuthService.logout(admin.sub, admin.jti, req.ip || 'unknown', refreshToken);
    }
    async getProfile(admin) {
        return this.adminAuthService.getProfile(admin.sub);
    }
};
exports.AdminAuthController = AdminAuthController;
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 5 } }),
    (0, common_1.Post)('login'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Admin login' }),
    (0, swagger_1.ApiBody)({ type: admin_login_dto_1.AdminLoginDto }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Login successful or MFA required (requiresMfa: true + tempToken).' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [admin_login_dto_1.AdminLoginDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminAuthController.prototype, "login", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 300000, limit: 5 } }),
    (0, common_1.Post)('2fa/verify'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Admin 2FA verify — exchange tempToken + TOTP for session tokens' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Login successful.' }),
    (0, swagger_1.ApiResponse)({ status: 401, description: 'TempToken expired or invalid 2FA code.' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [admin_verify_2fa_dto_1.AdminVerify2faDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminAuthController.prototype, "verify2fa", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 10 } }),
    (0, common_1.Post)('refresh'),
    (0, swagger_1.ApiOperation)({ summary: 'Refresh admin token' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'New access token returned.' }),
    (0, swagger_1.ApiResponse)({ status: 401, description: 'Refresh token is invalid or expired.' }),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminAuthController.prototype, "refreshToken", null);
__decorate([
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.Post)('logout'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Admin logout' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Logout successful.' }),
    (0, swagger_1.ApiResponse)({ status: 401, description: 'Invalid token.' }),
    __param(0, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminAuthController.prototype, "logout", null);
__decorate([
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.Get)('profile'),
    (0, swagger_1.ApiOperation)({ summary: 'Get admin profile' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Admin profile returned.' }),
    (0, swagger_1.ApiResponse)({ status: 401, description: 'Admin token is invalid or expired.' }),
    __param(0, (0, current_admin_decorator_1.CurrentAdmin)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AdminAuthController.prototype, "getProfile", null);
exports.AdminAuthController = AdminAuthController = __decorate([
    (0, swagger_1.ApiTags)('admin-auth'),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/auth'),
    __metadata("design:paramtypes", [admin_auth_service_1.AdminAuthService,
        config_1.ConfigService])
], AdminAuthController);
