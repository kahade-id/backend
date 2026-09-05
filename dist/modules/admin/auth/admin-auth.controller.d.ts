import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { AdminVerify2faDto } from './dto/admin-verify-2fa.dto';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
export declare class AdminAuthController {
    private readonly adminAuthService;
    private readonly configService;
    constructor(adminAuthService: AdminAuthService, configService: ConfigService);
    private getRefreshCookiePath;
    private setRefreshCookie;
    private clearRefreshCookie;
    login(dto: AdminLoginDto, req: Request, res: Response): Promise<{
        requiresMfa: true;
        tempToken: string;
    } | {
        accessToken: string;
        admin: {
            id: string;
            adminId: string;
            fullName: string;
            email: string;
            role: string;
            isActive: boolean;
            isMfaEnabled: boolean;
            lastLoginAt: string | null;
        };
    }>;
    verify2fa(dto: AdminVerify2faDto, req: Request, res: Response): Promise<{
        accessToken: string;
        admin: {
            id: string;
            adminId: string;
            fullName: string;
            email: string;
            role: string;
            isActive: boolean;
            isMfaEnabled: boolean;
            lastLoginAt: string | null;
        };
    }>;
    refreshToken(req: Request, res: Response): Promise<{
        accessToken: string;
    }>;
    logout(admin: AdminJwtPayload, req: Request, res: Response): Promise<{
        message: string;
    }>;
    getProfile(admin: AdminJwtPayload): Promise<{
        id: string;
        adminId: string;
        fullName: string;
        email: string;
        role: string;
        isActive: boolean;
        isMfaEnabled: boolean;
        lastLoginAt: Date | null;
        lastLoginIp: string | null;
    }>;
}
