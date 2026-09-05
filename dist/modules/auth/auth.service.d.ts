import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { TokenService } from './token.service';
import { OtpService } from './otp.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { Queue } from 'bull';
import { EmailJobData } from '../queue/processors/email.processor';
import { AuditLogService } from '../../common/services/audit-log.service';
import { RealtimeService } from '../realtime/realtime.service';
import { OtpGatewayService } from './otp-gateway.service';
interface LoginUserPayload {
    id: string;
    userId: string;
    username: string | null;
    email: string;
    fullName: string;
    avatarUrl: string | null;
    bio: string | null;
    accountType: string;
    emailVerified: boolean;
    kycStatus: string;
    isKahadePlus: boolean;
    subscriptionExpiresAt: string | null;
    membershipRank: string;
    isMfaEnabled: boolean;
    phoneNumber: string | null;
    phoneVerified: boolean;
    dateOfBirth: string | null;
    gender: string | null;
    createdAt: string;
}
type LoginResult = {
    requires2FA: true;
    tempToken: string;
} | {
    accessToken: string;
    refreshToken: string;
    user: LoginUserPayload;
};
export declare class AuthService {
    private prisma;
    private redis;
    private tokenService;
    private otpService;
    private otpGateway;
    private configService;
    private auditLog;
    private realtime;
    private readonly emailQueue;
    private readonly logger;
    constructor(prisma: PrismaService, redis: RedisService, tokenService: TokenService, otpService: OtpService, otpGateway: OtpGatewayService, configService: ConfigService, auditLog: AuditLogService, realtime: RealtimeService, emailQueue: Queue<EmailJobData>);
    register(dto: Record<string, any> & {
        fullName: string;
    }, ipAddress?: string): Promise<{
        message: string;
    }>;
    private normalizePhoneNumber;
    requestPhoneOtp(phoneNumber: string, method: 'SMS' | 'WHATSAPP', ipAddress?: string, deviceId?: string): Promise<{
        message: string;
        debugCode?: string;
    }>;
    private shouldExposeDebugOtp;
    verifyPhoneOtp(phoneNumber: string, code: string, deviceId: string, deviceInfo: string | undefined, ipAddress: string): Promise<{
        status: 'new_user';
        tempToken: string;
    } | {
        status: 'existing_user';
        requires2FA?: boolean;
        tempToken?: string;
        accessToken?: string;
        refreshToken?: string;
        user?: LoginUserPayload;
    }>;
    requestPhoneChange(userId: string, newPhoneNumber: string, currentPassword: string, method: 'SMS' | 'WHATSAPP', mfaCode?: string, ipAddress?: string): Promise<{
        message: string;
    }>;
    confirmPhoneChange(userId: string, newPhoneNumber: string, code: string): Promise<{
        message: string;
    }>;
    private verifySensitiveMfa;
    phoneRegister(dto: {
        tempToken: string;
        fullName: string;
        username: string;
        dateOfBirth: string;
        gender: string;
        email: string;
        password: string;
        pin: string;
        address?: string;
        referralCode?: string;
    }, deviceId: string, deviceInfo: string | undefined, ipAddress: string): Promise<{
        accessToken: string;
        refreshToken: string;
        user: LoginUserPayload;
    }>;
    setUsername(userId: string, username: string): Promise<{
        user: Record<string, unknown>;
    }>;
    verifyEmail(email: string, otp: string): Promise<{
        message: string;
    }>;
    resendVerification(email: string, ipAddress?: string): Promise<{
        message: string;
    }>;
    correctEmail(userId: string, newEmail: string, password: string, mfaCode?: string, ipAddress?: string): Promise<{
        message: string;
    }>;
    forgotPassword(email: string, ipAddress?: string): Promise<{
        message: string;
    }>;
    resetPassword(email: string, otp: string, newPassword: string, confirmPassword: string): Promise<{
        message: string;
    }>;
    login(dto: {
        email: string;
        password: string;
        deviceId: string;
        deviceInfo?: string;
    }, ipAddress: string): Promise<LoginResult>;
    verify2faLogin(tempToken: string, code: string, deviceId: string, deviceInfo: string, ipAddress: string): Promise<{
        accessToken: string;
        refreshToken: string;
        user: LoginUserPayload;
    }>;
    refreshToken(refreshToken: string): Promise<{
        accessToken: string;
        refreshToken: string;
    }>;
    logout(userId: string, sessionId: string, accessTokenJti: string, logoutAll: boolean): Promise<{
        message: string;
    }>;
    verifyPassword(userId: string, password: string): Promise<{
        verified: boolean;
    }>;
    changePassword(userId: string, dto: ChangePasswordDto, currentAccessTokenJti?: string, _currentSessionId?: string): Promise<{
        message: string;
    }>;
    get2faStatus(userId: string): Promise<{
        enabled: boolean;
    }>;
    setup2fa(userId: string, password: string): Promise<{
        secret: string;
        qrCodeUrl: string;
        otpauthUrl: string;
        backupCodes: string[];
    }>;
    enable2fa(userId: string, code: string): Promise<{
        message: string;
    }>;
    disable2fa(userId: string, password: string, code: string, emailOtpCode: string): Promise<{
        message: string;
    }>;
    regenerateBackupCodes(userId: string, password: string, code: string): Promise<{
        backupCodes: string[];
    }>;
    requestDisable2faOtp(userId: string, ipAddress?: string): Promise<{
        message: string;
    }>;
    private sendVerificationEmail;
    private getWalletPinPepper;
    private validatePinPolicy;
    private sendPasswordResetEmail;
    private dispatchEmail;
    private readonly BACKUP_CODE_LENGTH;
    private readonly BACKUP_CODE_PATTERN;
    private checkAndConsumeBackupCode;
    private trackDevice;
    private notifyBackupCodeUsed;
    private createSecurityNotification;
    private notifyAccountLocked;
    private notifyNewDeviceLogin;
    private notifyRefreshTokenReuse;
    private saveSession;
    private getTempTokenTtlSeconds;
    private getAccessTokenTtlSeconds;
    private getRefreshTokenTtlSeconds;
    private getRefreshTokenExpiryDate;
    private extractBcryptRounds;
    private revokeSessionsInRedis;
}
export {};
