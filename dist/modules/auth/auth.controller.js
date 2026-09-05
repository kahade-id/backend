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
exports.AuthController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const config_1 = require("@nestjs/config");
const throttler_1 = require("@nestjs/throttler");
const auth_service_1 = require("./auth.service");
const token_service_1 = require("./token.service");
const captcha_service_1 = require("./captcha.service");
const otp_gateway_service_1 = require("./otp-gateway.service");
const csrf_service_1 = require("../../common/services/csrf.service");
const public_decorator_1 = require("../../common/decorators/public.decorator");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
const allow_response_fields_decorator_1 = require("../../common/decorators/allow-response-fields.decorator");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const dto_1 = require("./dto");
let AuthController = class AuthController {
    constructor(authService, tokenService, configService, csrfService, captchaService, otpGateway) {
        this.authService = authService;
        this.tokenService = tokenService;
        this.configService = configService;
        this.csrfService = csrfService;
        this.captchaService = captchaService;
        this.otpGateway = otpGateway;
    }
    async generateCaptcha() {
        return this.captchaService.generateChallenge();
    }
    getRefreshCookiePath() {
        const prefix = this.configService.get('app.apiPrefix') || 'v1';
        return `/${prefix}/auth/refresh`;
    }
    useSecureAuthCookies() {
        const nodeEnv = this.configService.get('app.nodeEnv') ?? process.env.NODE_ENV ?? 'production';
        const appUrl = this.configService.get('app.appUrl') ?? '';
        let isLocalHttpDevelopment = false;
        try {
            const parsedUrl = new URL(appUrl);
            isLocalHttpDevelopment = ['development', 'test'].includes(nodeEnv)
                && parsedUrl.protocol === 'http:'
                && ['localhost', '127.0.0.1'].includes(parsedUrl.hostname.toLowerCase());
        }
        catch {
        }
        return !isLocalHttpDevelopment;
    }
    setAccessTokenCookie(res, accessToken) {
        res.cookie('kahade_access_token', accessToken, {
            httpOnly: true,
            secure: this.useSecureAuthCookies(),
            sameSite: 'strict',
            path: '/',
            maxAge: 15 * 60 * 1000,
        });
    }
    setRefreshTokenCookie(res, refreshToken) {
        res.cookie('kahade_refresh_token', refreshToken, {
            httpOnly: true,
            secure: this.useSecureAuthCookies(),
            sameSite: 'strict',
            path: this.getRefreshCookiePath(),
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });
    }
    clearAuthCookies(res) {
        res.clearCookie('kahade_access_token', { path: '/' });
        res.clearCookie('kahade_refresh_token', { path: this.getRefreshCookiePath() });
    }
    async getCsrfToken(userId, jti) {
        const csrfToken = await this.csrfService.generateToken(userId, jti);
        return { csrfToken };
    }
    async register(dto, req) {
        const emailAuthEnabled = this.configService.get('app.emailAuthEnabled') ?? false;
        if (!emailAuthEnabled) {
            throw new common_1.UnauthorizedException({ code: 'EMAIL_AUTH_DISABLED', message: 'Email/password registration is not available. Please use phone number registration.' });
        }
        if (!dto.captchaId || dto.captchaAnswer === undefined) {
            throw new common_1.UnauthorizedException({ code: ErrorCodes.CAPTCHA_REQUIRED, message: 'Captcha verification is required' });
        }
        await this.captchaService.verifyChallenge(dto.captchaId, dto.captchaAnswer);
        return this.authService.register(dto, req.ip);
    }
    async getOtpMethods() {
        return { methods: this.otpGateway.getSupportedMethods() };
    }
    async requestOtp(dto, req) {
        const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
        return this.authService.requestPhoneOtp(dto.phoneNumber, dto.method, ipAddress, dto.deviceId);
    }
    async verifyOtp(dto, req, res) {
        const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
        const result = await this.authService.verifyPhoneOtp(dto.phoneNumber, dto.code, dto.deviceId, dto.deviceInfo, ipAddress);
        if (result.status === 'existing_user' && 'refreshToken' in result && result.refreshToken) {
            this.setRefreshTokenCookie(res, result.refreshToken);
            if ('accessToken' in result && result.accessToken) {
                this.setAccessTokenCookie(res, result.accessToken);
            }
        }
        return result;
    }
    async phoneRegister(dto, req, res) {
        const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
        const deviceId = dto.deviceId;
        const deviceInfo = req.headers['user-agent'] || 'unknown';
        const result = await this.authService.phoneRegister(dto, deviceId, deviceInfo, ipAddress);
        this.setRefreshTokenCookie(res, result.refreshToken);
        this.setAccessTokenCookie(res, result.accessToken);
        return result;
    }
    async requestPhoneChange(userId, dto, req) {
        const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
        return this.authService.requestPhoneChange(userId, dto.newPhoneNumber, dto.currentPassword, dto.method, dto.mfaCode, ipAddress);
    }
    async confirmPhoneChange(userId, dto) {
        return this.authService.confirmPhoneChange(userId, dto.newPhoneNumber, dto.code);
    }
    async setUsername(userId, dto) {
        return this.authService.setUsername(userId, dto.username);
    }
    async verifyEmail(dto) {
        return this.authService.verifyEmail(dto.email, dto.otp);
    }
    async verifyEmailLink(email, token, res) {
        const htmlPage = (title, heading, message, success) => `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f7f7f7; color: #111; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
  .card { background: #fff; border-radius: 16px; padding: 32px; max-width: 420px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.06); text-align: center; }
  .icon { width: 56px; height: 56px; border-radius: 28px; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center; font-size: 28px; color: #fff; background: ${success ? '#0C9C5F' : '#C62828'}; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { font-size: 14px; color: #444; margin: 0 0 16px; line-height: 1.5; }
  a.btn { display: inline-block; padding: 10px 20px; border-radius: 8px; background: #0C9C5F; color: #fff; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? '✓' : '!'}</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    <a class="btn" href="kahade://email-verified">Buka Aplikasi Kahade</a>
  </div>
</body>
</html>`;
        if (!email || !token) {
            res.status(common_1.HttpStatus.BAD_REQUEST).type('html').send(htmlPage('Verifikasi Email', 'Tautan Tidak Valid', 'Parameter email atau token hilang. Silakan minta ulang tautan verifikasi di aplikasi.', false));
            return;
        }
        try {
            await this.authService.verifyEmail(email, token);
            res.status(common_1.HttpStatus.OK).type('html').send(htmlPage('Email Terverifikasi', 'Email Berhasil Diverifikasi', 'Terima kasih! Alamat email Anda sudah terverifikasi. Anda bisa melanjutkan menggunakan aplikasi Kahade.', true));
        }
        catch {
            const humanMessage = 'Tautan verifikasi tidak valid atau sudah kedaluwarsa. Silakan minta tautan baru dari aplikasi Kahade.';
            res.status(common_1.HttpStatus.BAD_REQUEST).type('html').send(htmlPage('Verifikasi Gagal', 'Verifikasi Gagal', humanMessage, false));
        }
    }
    async resendVerification(dto, req) {
        return this.authService.resendVerification(dto.email, req.ip);
    }
    async correctEmail(userId, dto, req) {
        return this.authService.correctEmail(userId, dto.newEmail, dto.password, dto.mfaCode, req.ip);
    }
    async login(dto, req, res) {
        const emailAuthEnabled = this.configService.get('app.emailAuthEnabled') ?? false;
        if (!emailAuthEnabled) {
            throw new common_1.UnauthorizedException({ code: 'EMAIL_AUTH_DISABLED', message: 'Email/password login is not available. Please use phone number login.' });
        }
        const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
        const captchaRequired = await this.captchaService.shouldRequireLoginCaptcha(ipAddress);
        if (captchaRequired) {
            if (!dto.captchaId || dto.captchaAnswer === undefined) {
                throw new common_1.UnauthorizedException({ code: ErrorCodes.CAPTCHA_REQUIRED, message: 'Captcha verification is required after repeated failed login attempts' });
            }
            await this.captchaService.verifyChallenge(dto.captchaId, dto.captchaAnswer);
        }
        let result;
        try {
            result = await this.authService.login(dto, ipAddress);
        }
        catch (error) {
            const response = error instanceof common_1.UnauthorizedException ? error.getResponse() : null;
            const code = typeof response === 'object' && response !== null && 'code' in response
                ? response.code
                : undefined;
            if (code === ErrorCodes.INVALID_CREDENTIALS) {
                await this.captchaService.recordLoginFailure(ipAddress);
            }
            throw error;
        }
        await this.captchaService.clearLoginFailures(ipAddress);
        if ('refreshToken' in result) {
            this.setRefreshTokenCookie(res, result.refreshToken);
            if ('accessToken' in result) {
                this.setAccessTokenCookie(res, result.accessToken);
            }
            return result;
        }
        return result;
    }
    async verify2faLogin(dto, req, res) {
        const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
        const deviceInfo = dto.deviceInfo || req.headers['user-agent'] || 'unknown';
        const result = await this.authService.verify2faLogin(dto.tempToken, dto.code, dto.deviceId, deviceInfo, ipAddress);
        this.setRefreshTokenCookie(res, result.refreshToken);
        this.setAccessTokenCookie(res, result.accessToken);
        return result;
    }
    async refreshToken(req, body, res) {
        const refreshToken = req.cookies?.kahade_refresh_token || body?.refreshToken;
        if (!refreshToken) {
            this.clearAuthCookies(res);
            throw new common_1.UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Refresh token required' });
        }
        let result;
        try {
            result = await this.authService.refreshToken(refreshToken);
        }
        catch (error) {
            this.clearAuthCookies(res);
            throw error;
        }
        if (result['refreshToken']) {
            this.setRefreshTokenCookie(res, result['refreshToken']);
        }
        if (result['accessToken']) {
            this.setAccessTokenCookie(res, result['accessToken']);
        }
        return result;
    }
    async logout(userId, accessTokenJti, sessionId, dto, res) {
        this.clearAuthCookies(res);
        return this.authService.logout(userId, sessionId, accessTokenJti, dto.logoutAll ?? false);
    }
    async forgotPassword(dto, req) {
        if (!dto.captchaId || dto.captchaAnswer === undefined) {
            throw new common_1.UnauthorizedException({ code: ErrorCodes.CAPTCHA_REQUIRED, message: 'Captcha verification is required' });
        }
        await this.captchaService.verifyChallenge(dto.captchaId, dto.captchaAnswer);
        const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
        return this.authService.forgotPassword(dto.email, ipAddress);
    }
    async resetPassword(dto) {
        return this.authService.resetPassword(dto.email, dto.otp, dto.newPassword, dto.confirmPassword);
    }
    async verifyPassword(userId, dto) {
        return this.authService.verifyPassword(userId, dto.password);
    }
    async changePassword(userId, accessTokenJti, sessionId, dto) {
        return this.authService.changePassword(userId, dto, accessTokenJti, sessionId);
    }
    async get2faStatus(userId) {
        return this.authService.get2faStatus(userId);
    }
    async setup2fa(userId, dto) {
        return this.authService.setup2fa(userId, dto.password);
    }
    async enable2fa(userId, dto) {
        return this.authService.enable2fa(userId, dto.code);
    }
    async requestDisable2faOtp(userId, req) {
        return this.authService.requestDisable2faOtp(userId, req.ip);
    }
    async disable2fa(userId, dto) {
        return this.authService.disable2fa(userId, dto.password, dto.code, dto.emailOtpCode);
    }
    async regenerateBackupCodes(userId, dto) {
        return this.authService.regenerateBackupCodes(userId, dto.password, dto.code);
    }
};
exports.AuthController = AuthController;
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Post)('captcha/generate'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "generateCaptcha", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Get)('csrf-token'),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, current_user_decorator_1.CurrentUser)('jti')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "getCsrfToken", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, common_1.Post)('register'),
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 5 } }),
    (0, common_1.HttpCode)(common_1.HttpStatus.CREATED),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [dto_1.RegisterDto, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "register", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('otp-methods'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "getOtpMethods", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Post)('request-otp'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [dto_1.RequestOtpDto, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "requestOtp", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Post)('verify-otp'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, allow_response_fields_decorator_1.AllowResponseFields)('refreshToken'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [dto_1.VerifyPhoneOtpDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "verifyOtp", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 20 } }),
    (0, common_1.Post)('phone-register'),
    (0, common_1.HttpCode)(common_1.HttpStatus.CREATED),
    (0, allow_response_fields_decorator_1.AllowResponseFields)('refreshToken'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [dto_1.PhoneRegisterDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "phoneRegister", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 5 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('phone-change/request'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, dto_1.RequestPhoneChangeDto, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "requestPhoneChange", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('phone-change/confirm'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, dto_1.ConfirmPhoneChangeDto]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "confirmPhoneChange", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 5 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('set-username'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, dto_1.SetUsernameDto]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "setUsername", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, common_1.Post)('verify-email'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [dto_1.VerifyEmailDto]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "verifyEmail", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Get)('verify-email'),
    __param(0, (0, common_1.Query)('email')),
    __param(1, (0, common_1.Query)('token')),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "verifyEmailLink", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 3 } }),
    (0, common_1.Post)('resend-verification'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [dto_1.ResendVerificationDto, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "resendVerification", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 3 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('correct-email'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, dto_1.CorrectEmailDto, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "correctEmail", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, common_1.Post)('login'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, allow_response_fields_decorator_1.AllowResponseFields)('refreshToken'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [dto_1.LoginDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "login", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, common_1.Post)('2fa/verify-login'),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, allow_response_fields_decorator_1.AllowResponseFields)('refreshToken'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [dto_1.Verify2faLoginDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "verify2faLogin", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Post)('refresh'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, allow_response_fields_decorator_1.AllowResponseFields)('refreshToken'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, dto_1.RefreshTokenDto, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "refreshToken", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('logout'),
    (0, common_1.HttpCode)(200),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, current_user_decorator_1.CurrentUser)('jti')),
    __param(2, (0, current_user_decorator_1.CurrentUser)('sessionId')),
    __param(3, (0, common_1.Body)()),
    __param(4, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, dto_1.LogoutDto, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "logout", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 3 } }),
    (0, common_1.Post)('forgot-password'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [dto_1.ForgotPasswordDto, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "forgotPassword", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, common_1.Post)('reset-password'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [dto_1.ResetPasswordDto]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "resetPassword", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('verify-password'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, dto_1.VerifyPasswordDto]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "verifyPassword", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 5 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('change-password'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, current_user_decorator_1.CurrentUser)('jti')),
    __param(2, (0, current_user_decorator_1.CurrentUser)('sessionId')),
    __param(3, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, dto_1.ChangePasswordDto]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "changePassword", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Get)('2fa/status'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "get2faStatus", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 5 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('2fa/setup'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, allow_response_fields_decorator_1.AllowResponseFields)('secret', 'backupCodes'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, dto_1.Setup2faDto]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "setup2fa", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 5 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('2fa/enable'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, dto_1.Enable2faDto]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "enable2fa", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 3 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('2fa/request-disable-otp'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "requestDisable2faOtp", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('2fa/disable'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, dto_1.Disable2faDto]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "disable2fa", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 3 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('2fa/backup-codes/regenerate'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, allow_response_fields_decorator_1.AllowResponseFields)('backupCodes'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, dto_1.RegenerateBackupCodesDto]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "regenerateBackupCodes", null);
exports.AuthController = AuthController = __decorate([
    (0, swagger_1.ApiTags)('auth'),
    (0, common_1.Controller)('auth'),
    __metadata("design:paramtypes", [auth_service_1.AuthService,
        token_service_1.TokenService,
        config_1.ConfigService,
        csrf_service_1.CsrfService,
        captcha_service_1.CaptchaService,
        otp_gateway_service_1.OtpGatewayService])
], AuthController);
