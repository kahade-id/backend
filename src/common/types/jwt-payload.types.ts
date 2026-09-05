import { AdminRole } from '@prisma/client';

export interface UserJwtPayload {
  sub: string;
  userId: string;
  email: string;
  username: string | null;
  sessionId: string;
  kycStatus?: string;
  emailVerified?: boolean;
  jti: string;
  iat: number;
  exp: number;
}

export interface AdminJwtPayload {
  sub: string;
  adminId: string;
  email: string;
  role: AdminRole;
  scope?: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface TempTokenPayload {
  sub: string;
  scope: string;
  iat: number;
  exp: number;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}
