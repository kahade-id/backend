import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { CaptchaService } from './captcha.service';
import { OtpGatewayService, OtpDeliveryMethod } from './otp-gateway.service';
import { CsrfService } from '../../common/services/csrf.service';
import { RegisterDto, LoginDto, SetUsernameDto, VerifyEmailDto, ResendVerificationDto, Verify2faLoginDto, LogoutDto, ForgotPasswordDto, ResetPasswordDto, ChangePasswordDto, Setup2faDto, Enable2faDto, Disable2faDto, RegenerateBackupCodesDto, CorrectEmailDto, RefreshTokenDto, VerifyPasswordDto, RequestOtpDto, VerifyPhoneOtpDto, PhoneRegisterDto, RequestPhoneChangeDto, ConfirmPhoneChangeDto } from './dto';
export declare class AuthController {
    private authService;
    private tokenService;
    private configService;
    private csrfService;
    private captchaService;
    private otpGateway;
    constructor(authService: AuthService, tokenService: TokenService, configService: ConfigService, csrfService: CsrfService, captchaService: CaptchaService, otpGateway: OtpGatewayService);
    generateCaptcha(): Promise<{
        challengeId: string;
        targetX: number;
    }>;
    private getRefreshCookiePath;
    private useSecureAuthCookies;
    private setAccessTokenCookie;
    private setRefreshTokenCookie;
    private clearAuthCookies;
    getCsrfToken(userId: string, jti: string): Promise<{
        csrfToken: string;
    }>;
    register(dto: RegisterDto, req: Request): Promise<{
        message: string;
    }>;
    getOtpMethods(): Promise<{
        methods: OtpDeliveryMethod[];
    }>;
    requestOtp(dto: RequestOtpDto, req: Request): Promise<{
        message: string;
        debugCode?: string;
    }>;
    verifyOtp(dto: VerifyPhoneOtpDto, req: Request, res: Response): Promise<Record<string, unknown>>;
    phoneRegister(dto: PhoneRegisterDto, req: Request, res: Response): Promise<Record<string, unknown>>;
    requestPhoneChange(userId: string, dto: RequestPhoneChangeDto, req: Request): Promise<{
        message: string;
    }>;
    confirmPhoneChange(userId: string, dto: ConfirmPhoneChangeDto): Promise<{
        message: string;
    }>;
    setUsername(userId: string, dto: SetUsernameDto): Promise<{
        user: Record<string, unknown>;
    }>;
    verifyEmail(dto: VerifyEmailDto): Promise<{
        message: string;
    }>;
    verifyEmailLink(email: string, token: string, res: Response): Promise<void>;
    resendVerification(dto: ResendVerificationDto, req: Request): Promise<{
        message: string;
    }>;
    correctEmail(userId: string, dto: CorrectEmailDto, req: Request): Promise<{
        message: string;
    }>;
    login(dto: LoginDto, req: Request, res: Response): Promise<Record<string, unknown>>;
    verify2faLogin(dto: Verify2faLoginDto, req: Request, res: Response): Promise<Record<string, unknown>>;
    refreshToken(req: Request, body: RefreshTokenDto, res: Response): Promise<{
        accessToken: string;
        refreshToken?: string;
    }>;
    logout(userId: string, accessTokenJti: string, sessionId: string, dto: LogoutDto, res: Response): Promise<{
        message: string;
    }>;
    forgotPassword(dto: ForgotPasswordDto, req: Request): Promise<{
        message: string;
    }>;
    resetPassword(dto: ResetPasswordDto): Promise<{
        message: string;
    }>;
    verifyPassword(userId: string, dto: VerifyPasswordDto): Promise<{
        verified: boolean;
    }>;
    changePassword(userId: string, accessTokenJti: string, sessionId: string, dto: ChangePasswordDto): Promise<{
        message: string;
    }>;
    get2faStatus(userId: string): Promise<{
        enabled: boolean;
    }>;
    setup2fa(userId: string, dto: Setup2faDto): Promise<{
        secret: string;
        qrCodeUrl: string;
        otpauthUrl: string;
        backupCodes: string[];
    }>;
    enable2fa(userId: string, dto: Enable2faDto): Promise<{
        message: string;
    }>;
    requestDisable2faOtp(userId: string, req: Request): Promise<{
        message: string;
    }>;
    disable2fa(userId: string, dto: Disable2faDto): Promise<{
        message: string;
    }>;
    regenerateBackupCodes(userId: string, dto: RegenerateBackupCodesDto): Promise<{
        backupCodes: string[];
    }>;
}
