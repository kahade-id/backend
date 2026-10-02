import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { bcryptCompare } from '../../../common/utils/crypto.util';
import { AuditAction } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';

/**
 * Verifikasi password admin server-side untuk aksi sensitif — pola
 * AUT-013 / verifyAdminPasswordForForceAction, diekstrak agar dipakai
 * bersama (wallet adjust, commerce refund, dsb).
 *
 * - Password kosong → 401 REAUTH_PASSWORD_REQUIRED.
 * - Password salah → 401 REAUTH_INVALID_PASSWORD + kegagalan diaudit
 *   (fire-and-forget agar kegagalan audit tidak menggagalkan penolakan).
 */
@Injectable()
export class AdminPasswordService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async verifyAdminPassword(
    adminId: string,
    password: string | undefined,
    action: string,
    targetId: string,
    ipAddress: string,
  ): Promise<void> {
    if (!password) {
      throw new UnauthorizedException({
        code: ErrorCodes.REAUTH_PASSWORD_REQUIRED,
        message: 'Re-authentication required for this action. Provide your password.',
      });
    }
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin || !admin.isActive || admin.deletedAt) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Admin not found',
      });
    }
    const ok = await bcryptCompare(password, admin.password);
    if (!ok) {
      this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'AdminReauth',
        targetId,
        description: `Failed re-authentication attempt for ${action} on ${targetId}`,
        ipAddress,
      });
      throw new UnauthorizedException({
        code: ErrorCodes.REAUTH_INVALID_PASSWORD,
        message: 'Invalid password for re-authentication',
      });
    }
  }
}
