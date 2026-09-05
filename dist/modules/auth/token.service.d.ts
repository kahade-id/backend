import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AdminRole } from '@prisma/client';
export interface AccessTokenPayload {
    sub: string;
    userId: string;
    email: string;
    username: string;
    sessionId: string;
    kycStatus?: string;
    emailVerified?: boolean;
    jti: string;
    iss?: string;
    aud?: string;
}
export interface AdminTokenPayload {
    sub: string;
    adminId: string;
    email: string;
    role: AdminRole;
    scope?: string;
    jti: string;
    iat?: number;
    iss?: string;
    aud?: string;
}
export interface RefreshTokenPayload {
    sub: string;
    jti: string;
    iat?: number;
    iss?: string;
    aud?: string;
}
export interface TempTokenPayload {
    sub: string;
    scope: string;
    deviceId?: string;
    jti?: string;
    iss?: string;
    aud?: string;
}
export interface DecodedTokenPayload {
    jti?: string;
    sub?: string;
    [key: string]: unknown;
}
export declare const TOKEN_ISSUER = "kahade-auth";
export declare const USER_TOKEN_AUDIENCE = "kahade-api";
export declare const ADMIN_TOKEN_AUDIENCE = "kahade-admin-api";
export declare const REFRESH_TOKEN_AUDIENCE = "kahade-refresh";
export declare const ADMIN_REFRESH_TOKEN_AUDIENCE = "kahade-admin-refresh";
export declare const TEMP_TOKEN_AUDIENCE = "kahade-2fa";
export declare class TokenService {
    private jwtService;
    private configService;
    constructor(jwtService: JwtService, configService: ConfigService);
    signAccessToken(payload: {
        sub: string;
        userId: string;
        email: string;
        username: string;
        sessionId: string;
        kycStatus?: string;
        emailVerified?: boolean;
    }): string;
    signAdminAccessToken(payload: {
        sub: string;
        adminId: string;
        email: string;
        role: AdminRole;
        scope?: string;
    }): string;
    signRefreshToken(payload: {
        sub: string;
    }): string;
    signAdminRefreshToken(payload: {
        sub: string;
    }): string;
    signTempToken(payload: {
        sub: string;
        scope: string;
        deviceId?: string;
    }): string;
    verifyAccessToken(token: string): AccessTokenPayload;
    verifyAdminToken(token: string): AdminTokenPayload;
    verifyRefreshToken(token: string): RefreshTokenPayload;
    verifyAdminRefreshToken(token: string): RefreshTokenPayload;
    verifyTempToken(token: string): TempTokenPayload;
    decodeToken(token: string): DecodedTokenPayload | null;
}
