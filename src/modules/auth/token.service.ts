import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AdminRole } from '@prisma/client';
import { nanoid } from 'nanoid';

// Typed interfaces for decoded/verified JWT payloads
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

export const TOKEN_ISSUER = 'kahade-auth';
export const USER_TOKEN_AUDIENCE = 'kahade-api';
export const ADMIN_TOKEN_AUDIENCE = 'kahade-admin-api';
export const REFRESH_TOKEN_AUDIENCE = 'kahade-refresh';
export const ADMIN_REFRESH_TOKEN_AUDIENCE = 'kahade-admin-refresh';
export const TEMP_TOKEN_AUDIENCE = 'kahade-2fa';

@Injectable()
export class TokenService {
  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  /** Sign user access token (15 minutes) */
  signAccessToken(payload: {
    sub: string;
    userId: string;
    email: string;
    username: string;
    sessionId: string;
    kycStatus?: string;
    emailVerified?: boolean;
  }): string {
    const jti = nanoid();
    return this.jwtService.sign(
      { ...payload, jti, iss: TOKEN_ISSUER, aud: USER_TOKEN_AUDIENCE },
      {
        secret: this.configService.get<string>('jwt.secret'),
        expiresIn: this.configService.get('jwt.expiresIn') ?? '15m',
        algorithm: 'HS256',
      },
    );
  }

  /** Sign admin access token (30 minutes) */
  signAdminAccessToken(payload: {
    sub: string;
    adminId: string;
    email: string;
    role: AdminRole;
    scope?: string;
  }): string {
    const jti = nanoid();
    return this.jwtService.sign(
      { ...payload, jti, iss: TOKEN_ISSUER, aud: ADMIN_TOKEN_AUDIENCE },
      {
        secret: this.configService.get<string>('jwt.adminSecret'),
        expiresIn: this.configService.get('jwt.adminExpiresIn') ?? '30m',
        algorithm: 'HS256',
      },
    );
  }

  /** Sign refresh token (7 days) */
  signRefreshToken(payload: { sub: string }): string {
    const jti = nanoid();
    return this.jwtService.sign(
      { ...payload, jti, iss: TOKEN_ISSUER, aud: REFRESH_TOKEN_AUDIENCE },
      {
        secret: this.configService.get<string>('jwt.refreshSecret'),
        expiresIn: this.configService.get('jwt.refreshExpiresIn') ?? '7d',
        algorithm: 'HS256',
      },
    );
  }

  signAdminRefreshToken(payload: { sub: string }): string {
    const jti = nanoid();
    return this.jwtService.sign(
      { ...payload, jti, iss: TOKEN_ISSUER, aud: ADMIN_REFRESH_TOKEN_AUDIENCE },
      {
        secret: this.configService.get<string>('jwt.adminRefreshSecret'),
        expiresIn: this.configService.get('jwt.adminRefreshExpiresIn') ?? '7d',
        algorithm: 'HS256',
      },
    );
  }

  /** Sign temp token (5 minutes) — for 2FA/MFA flow */
  signTempToken(payload: { sub: string; scope: string; deviceId?: string }): string {
    const jti = nanoid();
    const tempSecret = this.configService.get<string>('jwt.tempSecret');
    if (!tempSecret) {
      throw new Error('JWT_TEMP_SECRET is not configured. Cannot issue temp tokens.');
    }
    return this.jwtService.sign(
      { ...payload, jti, iss: TOKEN_ISSUER, aud: TEMP_TOKEN_AUDIENCE },
      {
        secret: tempSecret,
        expiresIn: this.configService.get('jwt.tempExpiresIn') ?? '5m',
        algorithm: 'HS256',
      },
    );
  }

  /**
   * Verify user access token.
   */
  verifyAccessToken(token: string): AccessTokenPayload {
    return this.jwtService.verify(token, {
      secret: this.configService.get<string>('jwt.secret'),
      audience: USER_TOKEN_AUDIENCE,
      issuer: TOKEN_ISSUER,
      algorithms: ['HS256'],
    }) as AccessTokenPayload;
  }

  /**
   * Verify admin access token.
   */
  verifyAdminToken(token: string): AdminTokenPayload {
    return this.jwtService.verify(token, {
      secret: this.configService.get<string>('jwt.adminSecret'),
      audience: ADMIN_TOKEN_AUDIENCE,
      issuer: TOKEN_ISSUER,
      algorithms: ['HS256'],
    }) as AdminTokenPayload;
  }

  /**
   * Verify refresh token.
   */
  verifyRefreshToken(token: string): RefreshTokenPayload {
    return this.jwtService.verify(token, {
      secret: this.configService.get<string>('jwt.refreshSecret'),
      audience: REFRESH_TOKEN_AUDIENCE,
      issuer: TOKEN_ISSUER,
      algorithms: ['HS256'],
    }) as RefreshTokenPayload;
  }

  verifyAdminRefreshToken(token: string): RefreshTokenPayload {
    return this.jwtService.verify(token, {
      secret: this.configService.get<string>('jwt.adminRefreshSecret'),
      audience: ADMIN_REFRESH_TOKEN_AUDIENCE,
      issuer: TOKEN_ISSUER,
      algorithms: ['HS256'],
    }) as RefreshTokenPayload;
  }

  /**
   * Verify temp token.
   */
  verifyTempToken(token: string): TempTokenPayload {
    const tempSecret = this.configService.get<string>('jwt.tempSecret');
    if (!tempSecret) {
      throw new Error('JWT_TEMP_SECRET is not configured. Cannot verify temp tokens.');
    }
    return this.jwtService.verify(token, {
      secret: tempSecret,
      audience: TEMP_TOKEN_AUDIENCE,
      issuer: TOKEN_ISSUER,
      algorithms: ['HS256'],
    }) as TempTokenPayload;
  }

  /** Decode token without verification */
  decodeToken(token: string): DecodedTokenPayload | null {
    return this.jwtService.decode(token) as DecodedTokenPayload | null;
  }
}
